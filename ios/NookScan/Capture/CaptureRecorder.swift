import Foundation
import simd

/// The source-agnostic capture pipeline: frames from any CaptureSource go through one ExposureLockPolicy, one
/// KeyframeSelector and one CaptureWriter. `handle` runs on the source's queue; `finish` on any background queue.
///
/// Every `stillEvery`-th keyframe also asks for a high-resolution still (contract §4.10). The keyframe then waits
/// for the still and is written from the high-resolution frame, so image, still and pose share one moment. If the
/// still fails, the video keyframe is written instead. Only one still is ever in flight: a slot that comes up
/// while one is pending just writes its video keyframe.
final class CaptureRecorder {
    /// Stills scored mixed against video frames on real scans, so one in three is enough. A keyframe falls back to its
    /// video frame whenever a still can't be taken.
    static let stillEvery = 3
    /// How long `finish` waits for a still in flight before writing its video keyframe instead.
    static let stillTimeout = 2.0

    let folder: URL
    private let writer: CaptureWriter
    private var selector: KeyframeSelector
    private var lockPolicy: ExposureLockPolicy
    private let lockCamera: (() -> CameraLock)?
    private let captureStill: ((@escaping (Keyframe?) -> Void) -> Void)?
    /// The keyframe waiting for its still: its video version and its index.
    private var pendingStill: (fallback: Keyframe, index: Int)?
    private let stillGroup = DispatchGroup()
    private let lock = NSLock()
    private var stopped = false
    private var firstTimestamp: Double?
    private var kept = 0
    private var paused = false
    private var stillsEnabled = true
    private let relockCamera: ((Double) -> CameraLock?)?
    /// Runs on the frames right after a lock on Auto, while nothing is kept. nil once it's finished.
    private var flickerProbe: FlickerProbe?
    private var probeDeadline = 0.0
    private var probePose: simd_float4x4?
    /// The check gives up after this long (a moving phone or a black view), and the scan goes on at the shutter in use.
    static let probeTimeout = 4.0

    /// `lockCamera` locks exposure and white balance and reports what it locked. nil for sources without a
    /// camera (replay): their frames are kept from the start. `captureStill` takes a high-resolution still
    /// (CaptureSource.captureStill); nil for sources without stills.
    init(folder: URL, info: CaptureInfo, lockCamera: (() -> CameraLock)? = nil,
         relockCamera: ((Double) -> CameraLock?)? = nil,
         captureStill: ((@escaping (Keyframe?) -> Void) -> Void)? = nil) throws {
        self.folder = folder
        self.lockCamera = lockCamera
        self.relockCamera = relockCamera
        self.captureStill = captureStill
        selector = KeyframeSelector(spacing: info.spacing)
        lockPolicy = ExposureLockPolicy(canLock: lockCamera != nil)
        writer = try CaptureWriter(folder: folder, info: info)
    }

    var keptCount: Int {
        lock.lock(); defer { lock.unlock() }
        return kept
    }

    var lockState: ExposureLockPolicy.State {
        lock.lock(); defer { lock.unlock() }
        return lockPolicy.state
    }

    /// Seconds after an exposure/white-balance lock before frames count as locked (contract §4.8).
    static let lockSettle = 0.3
    private var keyframesFrom = -Double.infinity

    /// While paused, tracking goes on and nothing is kept.
    var isPaused: Bool {
        get { lock.lock(); defer { lock.unlock() }; return paused }
        set { lock.lock(); paused = newValue; lock.unlock() }
    }

    /// Whether to take high-resolution stills. Set before the scan starts.
    var takesStills: Bool {
        get { lock.lock(); defer { lock.unlock() }; return stillsEnabled }
        set { lock.lock(); stillsEnabled = newValue; lock.unlock() }
    }

    /// Still working out whether the lights flicker: the phone should hold still.
    var isCheckingFlicker: Bool {
        lock.lock(); defer { lock.unlock() }
        return flickerProbe != nil
    }

    /// Decides on one frame and, for a keyframe, copies it out and queues it for writing.
    @discardableResult
    func handle(_ frame: CaptureFrame) -> FrameDecision {
        lock.lock()
        let (decision, wantsStill) = decide(frame)
        lock.unlock()
        // Outside the lock: a source may complete synchronously, and the completion takes the lock.
        if wantsStill, let captureStill {
            stillGroup.enter()
            captureStill { [self] still in
                stillArrived(still)
                stillGroup.leave()
            }
        }
        return decision
    }

    /// Called with `lock` held. `wantsStill`: the keyframe is parked in `pendingStill` and a still should be requested.
    private func decide(_ frame: CaptureFrame) -> (FrameDecision, wantsStill: Bool) {
        guard !stopped else { return (.stopped, false) }
        if lockPolicy.shouldLock(tracking: frame.tracking, timestamp: frame.timestamp) {
            let result = lockCamera?() ?? .none
            lockPolicy.didLock(result)
            // Frames still in the camera pipeline were exposed under auto exposure/white balance: let them pass.
            if result.exposureLocked || result.whiteBalanceLocked { keyframesFrom = frame.timestamp + Self.lockSettle }
            if result.exposureLocked, !result.isManual, relockCamera != nil {
                flickerProbe = FlickerProbe()
                probeDeadline = frame.timestamp + Self.probeTimeout
                probePose = nil
            }
        }
        guard lockPolicy.allowsKeyframes, frame.timestamp >= keyframesFrom else { return (.waitingForLock, false) }
        if flickerProbe != nil { return (stepFlickerProbe(frame), false) }
        if paused { return (.paused, false) }
        let decision = selector.evaluate(transform: frame.transform, tracking: frame.tracking, sharpness: frame.sharpness)
        guard decision == .keep else { return (decision, false) }
        if writer.isBusy { return (.busy, false) }
        guard var kf = frame.makeKeyframe() else { return (.busy, false) }
        selector.commit(transform: kf.transform)
        if firstTimestamp == nil { firstTimestamp = kf.timestamp }
        kept += 1
        if captureStill != nil, stillsEnabled, kept.isMultiple(of: Self.stillEvery), pendingStill == nil, writer.canTakeStill {
            pendingStill = (kf, kept)
            return (.keep, true)
        }
        append(kf, index: kept)
        return (.keep, false)
    }

    /// Called with `lock` held. One frame of the flicker check; nothing is kept until it finishes.
    private func stepFlickerProbe(_ frame: CaptureFrame) -> FrameDecision {
        guard let luma = frame.meanLuma(), var probe = flickerProbe, frame.timestamp < probeDeadline else {
            finishFlickerProbe(at: frame.timestamp, ev: flickerProbe?.measuredEV, flicker: flickerProbe?.measuredEV != nil)
            return .waitingForLock
        }
        // A moving view changes brightness by itself: only still frames count.
        defer { probePose = frame.transform }
        if let last = probePose, simd_distance(Pose.position(last), Pose.position(frame.transform)) > 0.005
            || Pose.angleDegrees(last, frame.transform) > 0.3 {
            return .waitingForLock
        }
        let action = probe.add(luma: luma, timestamp: frame.timestamp)
        flickerProbe = probe
        switch action {
        case .wait:
            break
        case .relock(let shutter):
            if let moved = relockCamera?(shutter) {
                lockPolicy.didRelock(moved)
            } else {
                finishFlickerProbe(at: frame.timestamp, ev: probe.measuredEV, flicker: true)   // stays at the shutter it has
            }
        case .done(let shutter, let ev):
            if let shutter, lockPolicy.record.exposureDuration != shutter, let moved = relockCamera?(shutter) {
                lockPolicy.didRelock(moved)
            }
            finishFlickerProbe(at: frame.timestamp, ev: ev, flicker: shutter != nil)
        }
        return .waitingForLock
    }

    /// Called with `lock` held.
    private func finishFlickerProbe(at timestamp: Double, ev: Float?, flicker: Bool) {
        flickerProbe = nil
        var record = lockPolicy.record
        record.flickerDetected = flicker
        record.flickerEV = ev.map(Double.init)
        lockPolicy.didRelock(record)
        keyframesFrom = timestamp + Self.lockSettle
    }

    /// Writes the keyframe waiting for a still: from the still's frame when there is one, else the video frame.
    private func stillArrived(_ still: Keyframe?) {
        lock.lock(); defer { lock.unlock() }
        guard let (fallback, index) = pendingStill else { return }   // finish gave up waiting
        pendingStill = nil
        append(still ?? fallback, index: index)
    }

    /// Called with `lock` held.
    private func append(_ kf: Keyframe, index: Int) {
        writer.append(kf, index: index, time: max(0, kf.timestamp - (firstTimestamp ?? kf.timestamp)))
    }

    /// Stops accepting frames, waits for the writer and writes the JSON files.
    func finish(floorY: Float?, ending: CaptureEnding? = nil) throws -> CaptureSummary {
        lock.lock(); stopped = true; lock.unlock()
        _ = stillGroup.wait(timeout: .now() + Self.stillTimeout)
        lock.lock()
        if let (fallback, index) = pendingStill {
            pendingStill = nil
            append(fallback, index: index)
        }
        let cameraLock = lockPolicy.record
        lock.unlock()
        return try writer.finish(floorY: floorY, cameraLock: cameraLock, ending: ending)
    }

    /// Close to the server's upload limit: the scan should wrap up.
    var isNearlyFull: Bool { writer.isNearlyFull }

    /// Stops accepting frames and waits for in-flight writes, so the folder can be deleted safely.
    func cancel() {
        lock.lock(); stopped = true; lock.unlock()
        writer.cancel()
    }
}
