import Foundation
import simd

/// Runs one capture for the UI: source → CaptureRecorder, plus the guidance state (frame count, tracking,
/// slow-down, coverage). Frame handling happens on the source's queue; published state is updated on main.
final class CaptureController: ObservableObject, Identifiable {
    enum Phase: Equatable {
        case recording
        case saving
        case saved(CaptureSummary)
        case failed(String)
    }

    static let sectors = 12
    static let minFrames = 30

    @Published private(set) var phase: Phase = .recording
    @Published private(set) var frameCount = 0
    @Published private(set) var tracking: TrackingStatus = .limited("Starting up")
    @Published private(set) var tooFast = false
    @Published private(set) var coverage = [Bool](repeating: false, count: CaptureController.sectors)
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

    init(source: CaptureSource, capturesRoot: URL) {
        self.source = source
        self.capturesRoot = capturesRoot
    }

    var isLive: Bool { source is LiveCaptureSource }

    func start() {
        guard !started else { return }
        started = true
        let folder = CaptureStore.newCaptureFolder(in: capturesRoot)
        let recorder: CaptureRecorder
        do {
            recorder = try CaptureRecorder(folder: folder, info: CaptureInfo(device: source.deviceName, lidar: source.hasDepth))
        } catch {
            phase = .failed(error.localizedDescription)
            return
        }
        self.recorder = recorder
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
        let sector = decision == .keep
            ? Int(Pose.yaw(frame.transform) / (2 * .pi) * Float(Self.sectors)) % Self.sectors : nil
        guard sector != nil || frame.timestamp - lastPublish >= 0.1 else { return }
        lastPublish = frame.timestamp
        let count = recorder.keptCount, tracking = frame.tracking
        let fast = motion.isTooFast || recentBlurry >= 5
        let progress = total.map { Double(framesSeen) / Double(max(1, $0)) }
        DispatchQueue.main.async {
            guard self.phase == .recording else { return }
            self.frameCount = count
            if self.tracking != tracking { self.tracking = tracking }
            if self.tooFast != fast { self.tooFast = fast }
            if let sector, !self.coverage[sector] { self.coverage[sector] = true }
            self.progress = progress
        }
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

    var coveredSectors: Int { coverage.filter { $0 }.count }
}
