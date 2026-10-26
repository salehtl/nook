import Foundation
import simd

/// Runs one capture for the UI: source → CaptureRecorder, plus the guidance state (frame count, tracking,
/// slow-down, exposure lock, guided passes and their coverage). Frame handling happens on the source's queue;
/// published state is updated on main.
final class CaptureController: ObservableObject, Identifiable {
    enum Phase: Equatable {
        case recording
        case saving
        case saved(CaptureSummary)
        case failed(String)
    }

    static let minFrames = 30

    @Published private(set) var phase: Phase = .recording
    @Published private(set) var frameCount = 0
    @Published private(set) var tracking: TrackingStatus = .limited("Starting up")
    @Published private(set) var tooFast = false
    /// Current guided pass and the heading coverage of each pass.
    @Published private(set) var guide = PassGuide()
    /// Exposure and white-balance lock (contract §4.8). Keyframes are only kept once it's settled.
    @Published private(set) var lockState = ExposureLockPolicy.State.settling(normalSince: nil)
    /// "Tilt the phone down…" when the phone is held wrong for the current pass.
    @Published private(set) var postureHint: String?
    /// Replay only: fraction of the recording played.
    @Published private(set) var progress: Double?
    /// The session was interrupted: no more frames are kept, but what was recorded can still be saved.
    @Published private(set) var interrupted = false
    /// The last failure can be fixed in the Settings app (camera access).
    @Published private(set) var needsSettings = false
    private let acceptLock = NSLock()
    private var accepting = true

    let source: CaptureSource
    let capturesRoot: URL
    private var recorder: CaptureRecorder?
    private var started = false
    private var discardRequested = false

    // Touched only on the source queue.
    private var motion = MotionMonitor()
    private var lastPublish = -Double.infinity
    private var framesSeen = 0
    private var recentBlurry = 0
    private var smoothedPitch: Float?

    init(source: CaptureSource, capturesRoot: URL) {
        self.source = source
        self.capturesRoot = capturesRoot
        lockState = ExposureLockPolicy(canLock: source.canLockCamera).state
    }

    var isLive: Bool { source is LiveCaptureSource }

    func start() {
        guard !started else { return }
        started = true
        let folder = CaptureStore.newCaptureFolder(in: capturesRoot)
        let recorder: CaptureRecorder
        do {
            let lockCamera: (() -> CameraLock)? = source.canLockCamera ? { [weak source] in source?.lockCamera() ?? .none } : nil
            let captureStill: ((@escaping (Keyframe?) -> Void) -> Void)? = source.canCaptureStills
                ? { [weak source] done in source.map { $0.captureStill(completion: done) } ?? done(nil) } : nil
            recorder = try CaptureRecorder(folder: folder, info: CaptureInfo(device: source.deviceName, lidar: source.hasDepth),
                                           lockCamera: lockCamera, captureStill: captureStill)
        } catch {
            phase = .failed(error.localizedDescription)
            return
        }
        self.recorder = recorder
        lockState = recorder.lockState
        (source as? LiveCaptureSource)?.onIssue = { [weak self] issue in
            DispatchQueue.main.async { self?.handle(issue) }
        }
        let total = (source as? ReplayCaptureSource)?.entries.count
        source.start(onFrame: { [weak self] frame in
            self?.process(frame, recorder: recorder, total: total)
        }, onEnd: { [weak self] in
            DispatchQueue.main.async { self?.finish() }
        })
    }

    private func handle(_ issue: LiveCaptureSource.Issue) {
        guard phase == .recording else { return }
        stopAccepting()
        switch issue {
        case .interrupted:
            interrupted = true
        case .failed(let message, let settings):
            needsSettings = settings
            if frameCount >= Self.minFrames {
                finish()   // keep what was recorded before the failure
            } else {
                discard()
                phase = .failed(message)
            }
        }
    }

    private func stopAccepting() {
        acceptLock.lock(); accepting = false; acceptLock.unlock()
    }

    private func process(_ frame: CaptureFrame, recorder: CaptureRecorder, total: Int?) {
        acceptLock.lock(); let ok = accepting; acceptLock.unlock()
        guard ok else { return }
        let decision = recorder.handle(frame)
        motion.update(timestamp: frame.timestamp, transform: frame.transform)
        framesSeen += 1
        recentBlurry = decision == .blurry ? recentBlurry + 1 : (decision == .keep ? 0 : recentBlurry)
        let pitch = Pose.pitchDegrees(frame.transform)
        smoothedPitch = smoothedPitch.map { $0 + 0.2 * (pitch - $0) } ?? pitch
        let kept = decision == .keep ? (yaw: Pose.yaw(frame.transform), pitch: pitch) : nil
        guard kept != nil || frame.timestamp - lastPublish >= 0.1 else { return }
        lastPublish = frame.timestamp
        let count = recorder.keptCount, tracking = frame.tracking, lockState = recorder.lockState
        let fast = motion.isTooFast || recentBlurry >= 5
        let hint = tracking.isNormal ? smoothedPitch.flatMap { recorder.pass.postureHint(pitchDegrees: $0) } : nil
        let progress = total.map { Double(framesSeen) / Double(max(1, $0)) }
        DispatchQueue.main.async {
            guard self.phase == .recording else { return }
            self.frameCount = count
            if self.tracking != tracking { self.tracking = tracking }
            if self.tooFast != fast { self.tooFast = fast }
            if self.lockState != lockState { self.lockState = lockState }
            if self.postureHint != hint { self.postureHint = hint }
            if let kept { self.guide.add(yaw: kept.yaw, pitchDegrees: kept.pitch) }
            self.progress = progress
        }
    }

    /// Moves to the next guided pass: keyframes from now on record it.
    func nextPass() {
        guard phase == .recording, let recorder, guide.advance() else { return }
        recorder.pass = guide.pass
    }

    /// Stops the source and saves. Called by "Done", or when a replay runs out.
    func finish() {
        guard phase == .recording, let recorder else { return }
        phase = .saving
        source.stop()
        let floorY = source.floorY
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try recorder.finish(floorY: floorY) }
            DispatchQueue.main.async {
                if self.discardRequested {
                    try? FileManager.default.removeItem(at: recorder.folder)
                    self.phase = .failed("Discarded")
                    return
                }
                switch result {
                case .success(let summary):
                    self.frameCount = summary.frameCount
                    self.phase = .saved(summary)
                case .failure(let error):
                    try? FileManager.default.removeItem(at: recorder.folder)
                    self.phase = .failed(error.localizedDescription)
                }
            }
        }
    }

    /// Stops the source and deletes the capture, whatever state it reached (a replay can finish and save
    /// while the discard confirmation is still on screen).
    func discard() {
        source.stop()
        guard let recorder else { return }
        switch phase {
        case .recording:
            phase = .failed("Discarded")
            DispatchQueue.global(qos: .userInitiated).async {
                recorder.cancel()
                try? FileManager.default.removeItem(at: recorder.folder)
            }
        case .saving:
            discardRequested = true
        case .saved:
            phase = .failed("Discarded")
            try? FileManager.default.removeItem(at: recorder.folder)
        case .failed:
            break
        }
    }
}
