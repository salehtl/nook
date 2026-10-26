import Foundation
import simd

/// The source-agnostic capture pipeline: frames from any CaptureSource go through one ExposureLockPolicy, one
/// KeyframeSelector and one CaptureWriter. `handle` runs on the source's queue; `finish` on any background queue.
final class CaptureRecorder {
    let folder: URL
    private let writer: CaptureWriter
    private var selector = KeyframeSelector()
    private var lockPolicy: ExposureLockPolicy
    private let lockCamera: (() -> CameraLock)?
    private let lock = NSLock()
    private var stopped = false
    private var firstTimestamp: Double?
    private var kept = 0
    private var currentPass: ScanPass = .chest

    /// `lockCamera` locks exposure and white balance and reports what it locked. nil for sources without a
    /// camera (replay): their frames are kept from the start.
    init(folder: URL, info: CaptureInfo, lockCamera: (() -> CameraLock)? = nil) throws {
        self.folder = folder
        self.lockCamera = lockCamera
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

    /// The guided pass recorded on keyframes from now on.
    var pass: ScanPass {
        get { lock.lock(); defer { lock.unlock() }; return currentPass }
        set { lock.lock(); currentPass = newValue; lock.unlock() }
    }

    /// Decides on one frame and, for a keyframe, copies it out and queues it for writing.
    @discardableResult
    func handle(_ frame: CaptureFrame) -> FrameDecision {
        lock.lock(); defer { lock.unlock() }
        guard !stopped else { return .stopped }
        if lockPolicy.shouldLock(tracking: frame.tracking, timestamp: frame.timestamp) {
            let result = lockCamera?() ?? .none
            lockPolicy.didLock(result)
            // Frames still in the camera pipeline were exposed under auto exposure/white balance: let them pass.
            if result.exposureLocked || result.whiteBalanceLocked { keyframesFrom = frame.timestamp + Self.lockSettle }
        }
        guard lockPolicy.allowsKeyframes, frame.timestamp >= keyframesFrom else { return .waitingForLock }
        let decision = selector.evaluate(transform: frame.transform, tracking: frame.tracking, sharpness: frame.sharpness)
        guard decision == .keep else { return decision }
        if writer.isBusy { return .busy }
        guard var kf = frame.makeKeyframe() else { return .busy }
        kf.pass = currentPass
        selector.commit(transform: kf.transform)
        if firstTimestamp == nil { firstTimestamp = kf.timestamp }
        kept += 1
        writer.append(kf, index: kept, time: kf.timestamp - firstTimestamp!)
        return .keep
    }

    /// Stops accepting frames, waits for the writer and writes the JSON files.
    func finish(floorY: Float?) throws -> CaptureSummary {
        lock.lock(); stopped = true; let cameraLock = lockPolicy.record; lock.unlock()
        return try writer.finish(floorY: floorY, cameraLock: cameraLock)
    }

    /// Stops accepting frames and waits for in-flight writes, so the folder can be deleted safely.
    func cancel() {
        lock.lock(); stopped = true; lock.unlock()
        writer.cancel()
    }
}
