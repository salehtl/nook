import CoreGraphics
import CoreImage
import Foundation
import simd

struct CaptureInfo {
    var device: String
    var lidar: Bool
    var appVersion: String = DeviceInfo.appVersion
    var created: Date = Date()
    var spacing = KeyframeSpacing.standard
}

/// Why a capture stopped (contract §4.13), so a scan that ended early can be explained from its files.
enum CaptureEnding: Equatable {
    case done
    case interrupted
    case failed(String)

    var reason: String {
        switch self {
        case .done: "done"
        case .interrupted: "interrupted"
        case .failed: "failed"
        }
    }

    var message: String? {
        if case .failed(let message) = self { return message }
        return nil
    }
}

/// Keeps seed points evenly spread: one per grid cell, however many frames see that spot. Without it the point budget
/// goes to whatever the phone sees first and most often (on real scans, the floor), and later frames add nothing.
struct SeedGrid {
    let cellSize: Float
    private var cells = Set<UInt64>()

    init(cellSize: Float) {
        self.cellSize = cellSize
    }

    var count: Int { cells.count }

    /// True the first time a point lands in its cell.
    mutating func insert(x: Float, y: Float, z: Float) -> Bool {
        func cell(_ v: Float) -> UInt64 {
            UInt64(truncatingIfNeeded: Int64((v / cellSize).rounded(.down)) + (1 << 20)) & 0x1F_FFFF
        }
        return cells.insert(cell(x) << 42 | cell(y) << 21 | cell(z)).inserted
    }
}

struct CaptureSummary: Equatable {
    let folder: URL
    let frameCount: Int
    let depthCount: Int
    let stillCount: Int
    let pointCount: Int
    let floorY: Float?
}

enum CaptureError: LocalizedError {
    case noFrames
    case write(String)

    var errorDescription: String? {
        switch self {
        case .noFrames: return "No keyframes were captured. Move the phone slowly around the room."
        case .write(let s): return "Could not save the capture: \(s)"
        }
    }
}

/// Writes the contract §4 capture folder. Keyframes are encoded on a private serial queue; high-resolution stills
/// (§4.10) on a second one, so a slow 12 MP encode doesn't hold up the keyframes behind it.
final class CaptureWriter {
    static let maxLongSide = 1920
    static let jpegQuality = 0.9
    static let stillQuality = 0.9
    /// Stills are stored smaller than the sensor's 12 MP: still sharper than the trainer's 1920 px, half the bytes.
    static let maxStillLongSide = 2880
    static let seedStride = 8           // depth pixels between seed points, both axes
    static let seedCell: Float = 0.03   // meters: at most one seed point per cell
    static let maxSeedPoints = 600_000
    static let seedDepthRange: ClosedRange<Float> = 0.1...8
    /// The jobs server refuses uploads over 4 GB (contract §5). Stills stop here, leaving room for the video frames.
    static let stillBudgetBytes: Int64 = 2_800_000_000
    /// Past this the capture screen asks to wrap up.
    static let nearlyFullBytes: Int64 = 3_600_000_000

    let folder: URL
    let info: CaptureInfo
    /// Keyframes allowed in flight before new ones are dropped as `.busy`.
    var maxPending = 6
    /// Stills allowed waiting for their encode before new ones are skipped (each holds a ~18 MB buffer).
    var maxPendingStills = 2

    private let queue = DispatchQueue(label: "nook.capture.writer", qos: .userInitiated)
    private let stillQueue = DispatchQueue(label: "nook.capture.writer.stills", qos: .utility)
    private let pendingLock = NSLock()
    private var pending = 0
    private var pendingStills = 0
    private var bytesWritten: Int64 = 0
    private lazy var ciContext = CIContext(options: [.cacheIntermediates: false])
    private lazy var stillContext = CIContext(options: [.cacheIntermediates: false])

    // Touched only on `queue`.
    private var frames: [[String: Any]] = []
    private var camera: Intrinsics?
    private var depthCount = 0
    private var stillCount = 0
    private var positions: [Float] = []
    private var colors: [UInt8] = []
    private var seedGrid = SeedGrid(cellSize: CaptureWriter.seedCell)
    private var error: Error?

    init(folder: URL, info: CaptureInfo) throws {
        self.folder = folder
        self.info = info
        let fm = FileManager.default
        try fm.createDirectory(at: folder.appendingPathComponent("images"), withIntermediateDirectories: true)
        if info.lidar {
            try fm.createDirectory(at: folder.appendingPathComponent("depth"), withIntermediateDirectories: true)
        }
    }

    var isBusy: Bool {
        pendingLock.lock(); defer { pendingLock.unlock() }
        return pending >= maxPending
    }

    /// Whether a still taken now could be written without growing the queues past their limits.
    var canTakeStill: Bool {
        pendingLock.lock(); defer { pendingLock.unlock() }
        return pending < maxPending - 1 && pendingStills < maxPendingStills && bytesWritten < Self.stillBudgetBytes
    }

    /// Close to the server's upload limit (contract §5).
    var isNearlyFull: Bool {
        pendingLock.lock(); defer { pendingLock.unlock() }
        return bytesWritten >= Self.nearlyFullBytes
    }

    private func countBytes(of url: URL) {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        pendingLock.lock(); bytesWritten += Int64(size); pendingLock.unlock()
    }

    /// Queues a keyframe. `index` is 1-based; `time` is seconds since the first keyframe.
    func append(_ kf: Keyframe, index: Int, time: Double) {
        pendingLock.lock(); pending += 1; pendingLock.unlock()
        queue.async { [self] in
            defer { pendingLock.lock(); pending -= 1; pendingLock.unlock() }
            guard error == nil else { return }
            do { try write(kf, index: index, time: time) } catch { self.error = error }
        }
    }

    /// Waits for queued keyframes, then writes points.ply, transforms.json and meta.json.
    /// `cameraLock` is what the exposure and white-balance lock achieved (contract §4.8).
    func finish(floorY: Float?, cameraLock: CameraLock = .none, ending: CaptureEnding? = nil) throws -> CaptureSummary {
        // Keyframes first (they queue still encodes), then the stills (a failed one queues a fix-up on `queue`),
        // then the JSON on `queue`, after those fix-ups.
        queue.sync {}
        stillQueue.sync {}
        return try queue.sync {
            if let error { throw CaptureError.write(error.localizedDescription) }
            guard let camera, !frames.isEmpty else { throw CaptureError.noFrames }
            // A keyframe that waited for its still can land after the ones behind it: list frames in index order.
            let frames = frames.sorted { ($0["file_path"] as? String ?? "") < ($1["file_path"] as? String ?? "") }
            do {
                var transforms: [String: Any] = [
                    "camera_model": "OPENCV",
                    "fl_x": camera.fx, "fl_y": camera.fy, "cx": camera.cx, "cy": camera.cy,
                    "w": camera.width, "h": camera.height,
                    "frames": frames,
                ]
                let pointCount = positions.count / 3
                if pointCount > 0 {
                    try PLY.write(positions: positions, colors: colors, to: folder.appendingPathComponent("points.ply"))
                    transforms["ply_file_path"] = "points.ply"
                }
                try writeJSON(transforms, to: "transforms.json")

                let iso = ISO8601DateFormatter()
                iso.timeZone = TimeZone(identifier: "UTC")
                var meta: [String: Any] = [
                    "version": 1,
                    "app": "nook-scan",
                    "app_version": info.appVersion,
                    "device": info.device,
                    "lidar": info.lidar,
                    "world": "arkit-gravity-y-up-meters",
                    "created": iso.string(from: info.created),
                    "frame_count": frames.count,
                    "floor_y": floorY.map { Self.num($0) as Any } ?? NSNull(),
                    "exposure_locked": cameraLock.exposureLocked,
                    "white_balance_locked": cameraLock.whiteBalanceLocked,
                    "keyframe_spacing": ["meters": Self.num(info.spacing.meters), "degrees": Self.num(info.spacing.degrees)],
                ]
                if cameraLock.exposureLocked {
                    if let iso = cameraLock.iso, iso.isFinite { meta["lock_iso"] = Self.decimal(iso, 3) }
                    if let d = cameraLock.exposureDuration, d.isFinite { meta["lock_exposure_duration"] = Self.decimal(d, 7) }
                }
                if cameraLock.whiteBalanceLocked, let g = cameraLock.whiteBalanceGains, [g.r, g.g, g.b].allSatisfy(\.isFinite) {
                    meta["lock_white_balance_gains"] = ["r": Self.decimal(g.r, 4), "g": Self.decimal(g.g, 4), "b": Self.decimal(g.b, 4)]
                }
                if let ending {
                    meta["end_reason"] = ending.reason
                    if let message = ending.message { meta["end_message"] = message }
                    meta["thermal_state"] = DeviceInfo.thermalState
                }
                try writeJSON(meta, to: "meta.json")
                return CaptureSummary(folder: folder, frameCount: frames.count, depthCount: depthCount,
                                      stillCount: stillCount, pointCount: pointCount, floorY: floorY)
            } catch {
                throw CaptureError.write(error.localizedDescription)
            }
        }
    }

    /// Waits for queued work and drops everything (used when a capture is discarded).
    func cancel() {
        queue.sync { error = CaptureError.noFrames }
        stillQueue.sync {}
    }

    // MARK: - Per keyframe (on `queue`)

    private func write(_ kf: Keyframe, index: Int, time: Double) throws {
        let name = String(format: "%06d", index)

        // Image: RGB, long side ≤ 1920, sensor orientation, JPEG 0.9.
        var image: CGImage
        switch kf.image {
        case .cgImage(let cg): image = cg
        case .pixelBuffer(let pb):
            // A still's 12 MP buffer is scaled down on the GPU first, never expanded to a full-size RGBA image.
            var ci = CIImage(cvPixelBuffer: pb)
            let s = Double(Self.maxLongSide) / Double(max(ci.extent.width, ci.extent.height))
            if s < 1 {
                ci = ci.applyingFilter("CILanczosScaleTransform", parameters: [kCIInputScaleKey: s, kCIInputAspectRatioKey: 1])
            }
            let rect = CGRect(x: 0, y: 0, width: ci.extent.width.rounded(.down), height: ci.extent.height.rounded(.down))
            guard let cg = ciContext.createCGImage(ci, from: rect, format: .RGBA8, colorSpace: ImageUtils.sRGB) else {
                throw ImageError.encode("images/\(name).jpg")
            }
            image = cg
        }
        let longSide = max(image.width, image.height)
        if longSide > Self.maxLongSide {
            let s = Double(Self.maxLongSide) / Double(longSide)
            let w = Int((Double(image.width) * s).rounded()), h = Int((Double(image.height) * s).rounded())
            guard let r = ImageUtils.resized(image, width: w, height: h) else { throw ImageError.encode("images/\(name).jpg") }
            image = r
        }
        let k = kf.intrinsics.scaled(toWidth: image.width, height: image.height)
        try ImageUtils.writeJPEG(image, to: folder.appendingPathComponent("images/\(name).jpg"), quality: Self.jpegQuality)
        countBytes(of: folder.appendingPathComponent("images/\(name).jpg"))

        var frame: [String: Any] = [
            "file_path": "images/\(name).jpg",
            "transform_matrix": Self.rows(kf.transform),
            "timestamp": (time * 1000).rounded() / 1000,
        ]
        if let d = kf.exposureDuration, d.isFinite, d > 0 { frame["exposure_duration"] = Self.decimal(d, 7) }
        if let ev = kf.exposureOffset, ev.isFinite { frame["exposure_offset"] = Self.decimal(ev, 4) }
        if let pass = kf.pass {
            frame["pass"] = pass.contractNumber
            if pass == .testWalk { frame["test_walk"] = true }
        }
        if let still = kf.still { frame.merge(queueStill(still, name: name)) { $1 } }
        if let camera {
            if abs(k.fx - camera.fx) > 1e-3 || abs(k.fy - camera.fy) > 1e-3 || abs(k.cx - camera.cx) > 1e-3 || abs(k.cy - camera.cy) > 1e-3 {
                frame["fl_x"] = k.fx; frame["fl_y"] = k.fy; frame["cx"] = k.cx; frame["cy"] = k.cy
            }
            if k.width != camera.width || k.height != camera.height {
                frame["w"] = k.width; frame["h"] = k.height
            }
        } else {
            camera = k
        }

        // Depth: Float32 meters → 16-bit millimeters, 0 = no data. Then sparse seed points with image colors.
        if let depth = kf.depth, info.lidar {
            let mm = depth.meters.map { m -> UInt16 in
                guard m.isFinite, m > 0 else { return 0 }
                return UInt16(min(65535, (m * 1000).rounded()))
            }
            try ImageUtils.writePNG16(mm, width: depth.width, height: depth.height,
                                      to: folder.appendingPathComponent("depth/\(name).png"))
            frame["depth_file_path"] = "depth/\(name).png"
            depthCount += 1
            addSeeds(depth: depth, image: image, intrinsics: k, transform: kf.transform)
        }
        frames.append(frame)
    }

    /// Queues the JPEG of a still (contract §4.10), at most `maxStillLongSide` px, and returns its frame keys. If the
    /// encode fails, the keys are taken off the frame again; the frame itself stays, with its video-resolution image.
    private func queueStill(_ still: Still, name: String) -> [String: Any] {
        let path = "images_hi/\(name).jpg"
        var ci = CIImage(cvPixelBuffer: still.image)
        let s = Double(Self.maxStillLongSide) / Double(max(ci.extent.width, ci.extent.height))
        if s < 1 {
            ci = ci.applyingFilter("CILanczosScaleTransform", parameters: [kCIInputScaleKey: s, kCIInputAspectRatioKey: 1])
        }
        // Whole pixels, so the size in transforms.json is exactly the written JPEG's.
        ci = ci.cropped(to: CGRect(x: 0, y: 0, width: ci.extent.width.rounded(.down), height: ci.extent.height.rounded(.down)))
        let k = still.intrinsics.scaled(toWidth: Int(ci.extent.width), height: Int(ci.extent.height))
        let scaled = ci
        pendingLock.lock(); pendingStills += 1; pendingLock.unlock()
        stillCount += 1
        stillQueue.async { [self] in
            defer { pendingLock.lock(); pendingStills -= 1; pendingLock.unlock() }
            do {
                let url = folder.appendingPathComponent(path)
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                let quality = kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption
                try stillContext.writeJPEGRepresentation(of: scaled, to: url, colorSpace: ImageUtils.sRGB, options: [quality: Self.stillQuality])
                countBytes(of: url)
            } catch {
                queue.async { [self] in
                    stillCount -= 1
                    guard let i = frames.firstIndex(where: { $0["hires_file_path"] as? String == path }) else { return }
                    for key in Self.stillKeys { frames[i][key] = nil }
                }
            }
        }
        return ["hires_file_path": path, "hires_w": k.width, "hires_h": k.height,
                "hires_fl_x": k.fx, "hires_fl_y": k.fy, "hires_cx": k.cx, "hires_cy": k.cy]
    }

    static let stillKeys = ["hires_file_path", "hires_w", "hires_h", "hires_fl_x", "hires_fl_y", "hires_cx", "hires_cy"]

    /// Back-projects every `seedStride`-th depth pixel into world space (OpenGL camera: +Y up, looking along −Z),
    /// keeping one point per `seedCell`.
    private func addSeeds(depth: DepthMap, image: CGImage, intrinsics k: Intrinsics, transform: simd_float4x4) {
        guard positions.count / 3 < Self.maxSeedPoints,
              let rgb = ImageUtils.rgbxPixels(image, width: depth.width, height: depth.height) else { return }
        let d = k.scaled(toWidth: depth.width, height: depth.height)
        let fx = Float(d.fx), fy = Float(d.fy), cx = Float(d.cx), cy = Float(d.cy)
        let step = Self.seedStride
        for v in stride(from: step / 2, to: depth.height, by: step) {
            for u in stride(from: step / 2, to: depth.width, by: step) {
                let i = v * depth.width + u
                let z = depth.meters[i]
                guard Self.seedDepthRange.contains(z) else { continue }
                if let c = depth.confidence, c[i] < 2 { continue }
                let pc = SIMD4<Float>((Float(u) + 0.5 - cx) / fx * z, -(Float(v) + 0.5 - cy) / fy * z, -z, 1)
                let pw = transform * pc
                guard seedGrid.insert(x: pw.x, y: pw.y, z: pw.z) else { continue }
                positions.append(contentsOf: [pw.x, pw.y, pw.z])
                colors.append(contentsOf: [rgb[i * 4], rgb[i * 4 + 1], rgb[i * 4 + 2]])
            }
        }
    }

    private func writeJSON(_ object: [String: Any], to name: String) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: folder.appendingPathComponent(name), options: .atomic)
    }

    /// Row-major nested arrays of a column-major simd matrix.
    static func rows(_ m: simd_float4x4) -> [[Double]] {
        (0..<4).map { r in (0..<4).map { c in num(m[c][r]) } }
    }

    /// `x` rounded to `digits` decimal places.
    static func decimal(_ x: Double, _ digits: Int) -> Double {
        let s = pow(10, Double(digits))
        return (x * s).rounded() / s
    }

    /// A Float as the shortest Double that prints like it (0.2354, not 0.23540000617504120).
    static func num(_ f: Float) -> Double {
        Double(f.description) ?? Double(f)
    }
}

enum PLY {
    /// Binary little-endian PLY with `x y z` float and `red green blue` uchar (contract §4.1).
    static func write(positions: [Float], colors: [UInt8], to url: URL) throws {
        let n = positions.count / 3
        precondition(colors.count == n * 3)
        var data = Data("""
        ply
        format binary_little_endian 1.0
        element vertex \(n)
        property float x
        property float y
        property float z
        property uchar red
        property uchar green
        property uchar blue
        end_header

        """.utf8)
        var body = [UInt8](repeating: 0, count: n * 15)
        body.withUnsafeMutableBytes { out in
            for i in 0..<n {
                let o = i * 15
                for a in 0..<3 {
                    out.storeBytes(of: positions[i * 3 + a].bitPattern.littleEndian, toByteOffset: o + a * 4, as: UInt32.self)
                }
                out[o + 12] = colors[i * 3]
                out[o + 13] = colors[i * 3 + 1]
                out[o + 14] = colors[i * 3 + 2]
            }
        }
        data.append(contentsOf: body)
        try data.write(to: url, options: .atomic)
    }
}
