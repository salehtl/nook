import Foundation
import simd

/// The source-agnostic capture pipeline: frames from any CaptureSource go through one KeyframeSelector and
/// one CaptureWriter. `handle` runs on the source's queue; `finish` on any background queue.
final class CaptureRecorder {
    let folder: URL
    private let writer: CaptureWriter
    private var selector = KeyframeSelector()
    private let lock = NSLock()
    private var stopped = false
    private var firstTimestamp: Double?
    private var kept = 0

    init(folder: URL, info: CaptureInfo) throws {
        self.folder = folder
        writer = try CaptureWriter(folder: folder, info: info)
    }

    var keptCount: Int {
        lock.lock(); defer { lock.unlock() }
        return kept
    }

    /// Decides on one frame and, for a keyframe, copies it out and queues it for writing.
    @discardableResult
    func handle(_ frame: CaptureFrame) -> FrameDecision {
        lock.lock(); defer { lock.unlock() }
        guard !stopped else { return .stopped }
        let decision = selector.evaluate(transform: frame.transform, tracking: frame.tracking, sharpness: frame.sharpness)
        guard decision == .keep else { return decision }
        if writer.isBusy { return .busy }
        guard let kf = frame.makeKeyframe() else { return .busy }
        selector.commit(transform: kf.transform)
        if firstTimestamp == nil { firstTimestamp = kf.timestamp }
        kept += 1
        writer.append(kf, index: kept, time: kf.timestamp - firstTimestamp!)
        return .keep
    }

    /// Stops accepting frames, waits for the writer and writes the JSON files.
    func finish(floorY: Float?) throws -> CaptureSummary {
        lock.lock(); stopped = true; lock.unlock()
        return try writer.finish(floorY: floorY)
    }

    /// Stops accepting frames and waits for in-flight writes, so the folder can be deleted safely.
    func cancel() {
        lock.lock(); stopped = true; lock.unlock()
        writer.cancel()
    }
}
