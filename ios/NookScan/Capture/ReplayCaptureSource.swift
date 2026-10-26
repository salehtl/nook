import CoreGraphics
import Foundation
import simd

/// Replays a recorded capture folder (contract §4) as if it were coming from ARKit: same frames, poses,
/// intrinsics and depth, all with normal tracking. Used in the simulator, where ARKit doesn't run, and in tests.
final class ReplayCaptureSource: CaptureSource {
    struct Entry {
        let timestamp: Double
        let transform: simd_float4x4
        let intrinsics: Intrinsics
        let imageURL: URL
        let depthURL: URL?
        /// Recorded exposure (capture v1.1), passed through when present.
        var exposureDuration: Double?
        var exposureOffset: Double?
    }

    let folder: URL
    let entries: [Entry]
    /// Pace frames by their timestamps times this factor (1 = real time, for the UI); 0 replays as fast as possible (tests).
    let timeScale: Double
    let deviceName: String
    let hasDepth: Bool
    /// Taken from the recording's meta.json: replay has no plane detection of its own.
    let floorY: Float?

    private let queue = DispatchQueue(label: "nook.capture.replay", qos: .userInitiated)
    private let lock = NSLock()
    private var cancelled = false

    init(folder: URL, timeScale: Double = 0) throws {
        self.folder = folder
        self.timeScale = timeScale
        let t = try Self.json(folder.appendingPathComponent("transforms.json"))
        let meta = (try? Self.json(folder.appendingPathComponent("meta.json"))) ?? [:]
        guard let frames = t["frames"] as? [[String: Any]] else { throw ReplayError.invalid("transforms.json has no frames") }
        let top = try Self.intrinsics(t, fallback: nil)
        entries = try frames.enumerated().map { i, f in
            guard let path = f["file_path"] as? String, let rows = f["transform_matrix"] as? [[NSNumber]],
                  rows.count == 4, rows.allSatisfy({ $0.count == 4 }) else {
                throw ReplayError.invalid("frame \(i) is missing file_path or transform_matrix")
            }
            var m = simd_float4x4()
            for r in 0..<4 { for c in 0..<4 { m[c][r] = rows[r][c].floatValue } }
            let ts = (f["timestamp"] as? NSNumber)?.doubleValue ?? Double(i) / 10
            return Entry(timestamp: ts, transform: m, intrinsics: try Self.intrinsics(f, fallback: top),
                         imageURL: folder.appendingPathComponent(path),
                         depthURL: (f["depth_file_path"] as? String).map { folder.appendingPathComponent($0) },
                         exposureDuration: (f["exposure_duration"] as? NSNumber)?.doubleValue,
                         exposureOffset: (f["exposure_offset"] as? NSNumber)?.doubleValue)
        }
        hasDepth = entries.contains { $0.depthURL != nil }
        floorY = (meta["floor_y"] as? NSNumber)?.floatValue
        deviceName = "\(DeviceInfo.model) (replay)"
    }

    func start(onFrame: @escaping (CaptureFrame) -> Void, onEnd: @escaping () -> Void) {
        lock.lock(); cancelled = false; lock.unlock()
        queue.async { [self] in
            run(onFrame: onFrame)
            onEnd()
        }
    }

    func stop() {
        lock.lock(); cancelled = true; lock.unlock()
    }

    private var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }

    /// Delivers every frame synchronously on the calling thread.
    func run(onFrame: (CaptureFrame) -> Void) {
        let start = Date()
        let t0 = entries.first?.timestamp ?? 0
        for e in entries {
            if isCancelled { return }
            if timeScale > 0 {
                let wait = (e.timestamp - t0) * timeScale - Date().timeIntervalSince(start)
                if wait > 0 { Thread.sleep(forTimeInterval: wait) }
            }
            onFrame(ReplayFrame(entry: e))
        }
    }

    /// Replays the whole folder through a CaptureRecorder into `output`. Synchronous.
    func record(into output: URL) throws -> CaptureSummary {
        let recorder = try CaptureRecorder(folder: output, info: CaptureInfo(device: deviceName, lidar: hasDepth))
        run { recorder.handle($0) }
        return try recorder.finish(floorY: floorY)
    }

    // MARK: Parsing

    private static func json(_ url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ReplayError.invalid("\(url.lastPathComponent) is not a JSON object")
        }
        return obj
    }

    private static func intrinsics(_ d: [String: Any], fallback: Intrinsics?) throws -> Intrinsics {
        func num(_ k: String) -> Double? { (d[k] as? NSNumber)?.doubleValue }
        guard let fx = num("fl_x") ?? fallback?.fx, let fy = num("fl_y") ?? fallback?.fy,
              let cx = num("cx") ?? fallback?.cx, let cy = num("cy") ?? fallback?.cy,
              let w = num("w").map(Int.init) ?? fallback?.width, let h = num("h").map(Int.init) ?? fallback?.height else {
            throw ReplayError.invalid("missing camera intrinsics")
        }
        return Intrinsics(fx: fx, fy: fy, cx: cx, cy: cy, width: w, height: h)
    }
}

enum ReplayError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        if case .invalid(let s) = self { return "Can't replay capture: \(s)" }
        return nil
    }
}

/// One replayed frame. The image is decoded once and shared between sharpness() and makeKeyframe().
private final class ReplayFrame: CaptureFrame {
    let entry: ReplayCaptureSource.Entry
    private lazy var image: CGImage? = ImageUtils.loadImage(entry.imageURL)

    init(entry: ReplayCaptureSource.Entry) { self.entry = entry }

    var timestamp: Double { entry.timestamp }
    var transform: simd_float4x4 { entry.transform }
    var tracking: TrackingStatus { .normal }

    func sharpness() -> Float {
        image.map { ImageUtils.sharpness(of: $0) } ?? 0
    }

    func makeKeyframe() -> Keyframe? {
        guard let image else { return nil }
        var depth: DepthMap?
        if let url = entry.depthURL, let png = ImageUtils.readPNG16(url) {
            depth = DepthMap(width: png.width, height: png.height, meters: png.values.map { Float($0) / 1000 }, confidence: nil)
        }
        let k = entry.intrinsics.width == image.width && entry.intrinsics.height == image.height
            ? entry.intrinsics : entry.intrinsics.scaled(toWidth: image.width, height: image.height)
        return Keyframe(timestamp: entry.timestamp, transform: entry.transform, intrinsics: k, image: .cgImage(image), depth: depth,
                        exposureDuration: entry.exposureDuration, exposureOffset: entry.exposureOffset)
    }
}
