import Foundation
import simd

/// Runs one capture for the UI: source → CaptureRecorder, plus what the screen shows (frame count, tracking,
/// slow-down, exposure lock, pause). Frame handling happens on the source's queue; published state is updated on main.
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
    /// Start was tapped: the camera settings are locked in and frames are being judged. Replay starts by itself.
    @Published private(set) var isStarted = false
    @Published private(set) var isPaused = false
    /// The flicker check is running: the phone should hold still.
    @Published private(set) var checkingFlicker = false
    /// Exposure and white-balance lock (contract §4.8). Keyframes are only kept once it's settled.
    @Published private(set) var lockState = ExposureLockPolicy.State.settling(normalSince: nil)
    /// Replay only: fraction of the recording played.
    @Published private(set) var progress: Double?
    /// The session was interrupted: no more frames are kept, but what was recorded can still be saved.
    @Published private(set) var interrupted = false
    /// The last failure can be fixed in the Settings app (camera access).
    @Published private(set) var needsSettings = false
    /// Not much free space on the phone when the scan started.
    @Published private(set) var lowStorage = false
    /// Close to the server's upload limit: time to wrap up.
    @Published private(set) var nearlyFull = false
    /// The separate RoomPlan pass (contract §4.12), started once the scan is saved, or nil when it isn't
    /// offered (no LiDAR, turned off in Settings, replay).
    @Published private(set) var roomPlan: RoomPlanPass?
    private let acceptLock = NSLock()
    private var accepting = true
    /// The last camera pose the source delivered (guarded by `acceptLock`): where the RoomPlan pass will start.
    private var lastPose: simd_float4x4?

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
    private var startedOnQueue = false

    init(source: CaptureSource, capturesRoot: URL) {
        self.source = source
        self.capturesRoot = capturesRoot
        lockState = ExposureLockPolicy(canLock: source.canLockCamera).state
    }

    var isLive: Bool { source is LiveCaptureSource }

    /// What a typical scan needs free: about 3.5 GB, plus the zip made to send it.
    static let minFreeBytes: Int64 = 8_000_000_000

    /// Whether a RoomPlan pass follows the scan: a live LiDAR capture with the setting on.
    var offersRoomPlan: Bool { isLive && source.hasDepth && RoomPlanSettings.isSupported && RoomPlanSettings.isEnabled }

    func start() {
        guard !started else { return }
        started = true
        let folder = CaptureStore.newCaptureFolder(in: capturesRoot)
        let recorder: CaptureRecorder
        do {
            let lockCamera: (() -> CameraLock)? = source.canLockCamera ? { [weak source] in source?.lockCamera() ?? .none } : nil
            let relock: ((Double) -> CameraLock?)? = source.canLockCamera ? { [weak source] in source?.relockCamera(shutter: $0) } : nil
            let captureStill: ((@escaping (Keyframe?) -> Void) -> Void)? = source.canCaptureStills
                ? { [weak source] done in source.map { $0.captureStill(completion: done) } ?? done(nil) } : nil
            recorder = try CaptureRecorder(folder: folder, info: CaptureInfo(device: source.deviceName, lidar: source.hasDepth),
                                           lockCamera: lockCamera, relockCamera: relock, captureStill: captureStill)
        } catch {
            phase = .failed(error.localizedDescription)
            return
        }
        self.recorder = recorder
        lockState = recorder.lockState
        if isLive, let free = try? capturesRoot.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            .volumeAvailableCapacityForImportantUsage {
            lowStorage = free < Self.minFreeBytes
        }
        (source as? LiveCaptureSource)?.onIssue = { [weak self] issue in
            DispatchQueue.main.async { self?.handle(issue) }
        }
        let total = (source as? ReplayCaptureSource)?.entries.count
        if !isLive { begin() }
        source.start(onFrame: { [weak self] frame in
            self?.process(frame, recorder: recorder, total: total)
        }, onEnd: { [weak self] in
            DispatchQueue.main.async { self?.finish() }
        })
    }

    /// Start: the camera settings are final from here on. Exposure locks about a second later.
    func begin() {
        guard !isStarted, let recorder else { return }
        let settings = CameraSettings.current
        (source as? LiveCaptureSource)?.settings = settings
        recorder.takesStills = settings.takeStills
        isStarted = true
        acceptLock.lock(); startedOnQueue = true; acceptLock.unlock()
    }

    func togglePause() {
        guard phase == .recording, let recorder else { return }
        isPaused.toggle()
        recorder.isPaused = isPaused
    }

    private func handle(_ issue: LiveCaptureSource.Issue) {
        guard phase == .recording else { return }
        stopAccepting()
        switch issue {
        case .interrupted:
            // Nothing recorded yet: there's nothing to save, and a stopped session can't resume.
            if recorder?.keptCount ?? 0 == 0 {
                discard()
                phase = .failed("Scan interrupted before anything was saved. Close this and start again.")
            } else {
                interrupted = true
            }
        case .failed(let message, let settings):
            needsSettings = settings
            if frameCount >= Self.minFrames {
                finish(ending: .failed(message))   // keep what was recorded before the failure
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
        acceptLock.lock()
        let ok = accepting
        if ok, frame.tracking.isNormal { lastPose = frame.transform }
        let started = startedOnQueue
        acceptLock.unlock()
        guard ok else { return }
        guard started else {   // the ready screen: only tracking matters
            guard frame.timestamp - lastPublish >= 0.1 else { return }
            lastPublish = frame.timestamp
            let tracking = frame.tracking
            DispatchQueue.main.async { if self.tracking != tracking { self.tracking = tracking } }
            return
        }
        let decision = recorder.handle(frame)
        motion.update(timestamp: frame.timestamp, transform: frame.transform)
        framesSeen += 1
        recentBlurry = decision == .blurry ? recentBlurry + 1 : (decision == .keep ? 0 : recentBlurry)
        guard decision == .keep || frame.timestamp - lastPublish >= 0.1 else { return }
        lastPublish = frame.timestamp
        let count = recorder.keptCount, tracking = frame.tracking, lockState = recorder.lockState
        if case .locked(let lock) = lockState, let shutter = lock.exposureDuration {
            motion.exposure = shutter
            // A flicker-safe or hand-picked slow shutter blurs more by choice: warn only when it's really too fast.
            motion.maxBlurPixels = shutter > AdaptiveShutter.slowest * 1.001 ? 4 : 2
        }
        if decision == .paused { recentBlurry = 0 }
        let fast = decision != .paused && (motion.isTooFast || recentBlurry >= 5)   // walking while paused is the point
        let checking = recorder.isCheckingFlicker
        let full = recorder.isNearlyFull
        let progress = total.map { Double(framesSeen) / Double(max(1, $0)) }
        DispatchQueue.main.async {
            guard self.phase == .recording else { return }
            self.frameCount = count
            if self.tracking != tracking { self.tracking = tracking }
            if self.tooFast != fast { self.tooFast = fast }
            if self.lockState != lockState { self.lockState = lockState }
            if self.checkingFlicker != checking { self.checkingFlicker = checking }
            if self.nearlyFull != full { self.nearlyFull = full }
            self.progress = progress
        }
    }

    /// Stops the source and saves. Called by "Done", when a replay runs out, or (with `ending`) when ARKit fails.
    func finish(ending: CaptureEnding? = nil) {
        guard phase == .recording, let recorder else { return }
        let ending = ending ?? (interrupted ? .interrupted : .done)
        phase = .saving
        source.stop()
        let floorY = source.floorY
        acceptLock.lock(); let endPose = lastPose; acceptLock.unlock()
        let anchors = CaptureAnchors(floorY: floorY, walls: source.wallPlanes, endPose: endPose)
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try recorder.finish(floorY: floorY, ending: ending) }
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
                    if self.offersRoomPlan, summary.frameCount >= Self.minFrames {
                        let pass = RoomPlanPass(folder: summary.folder, anchors: anchors)
                        self.roomPlan = pass
                        pass.start()
                    }
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
            roomPlan?.skip()
            phase = .failed("Discarded")
            try? FileManager.default.removeItem(at: recorder.folder)
        case .failed:
            break
        }
    }
}
