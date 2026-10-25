import CoreGraphics
import CoreImage
import Foundation
import simd

struct CaptureInfo {
    var device: String
    var lidar: Bool
    var appVersion: String = DeviceInfo.appVersion
    var created: Date = Date()
}

struct CaptureSummary: Equatable {
    let folder: URL
    let frameCount: Int
    let depthCount: Int
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

/// Writes the contract §4 capture folder. All encoding and file I/O happens on a private serial queue.
final class CaptureWriter {
    static let maxLongSide = 1920
    static let jpegQuality = 0.9
    static let seedStride = 8           // depth pixels between seed points, both axes
    static let maxSeedPoints = 400_000
    static let seedDepthRange: ClosedRange<Float> = 0.1...8

    let folder: URL
    let info: CaptureInfo
    /// Keyframes allowed in flight before new ones are dropped as `.busy`.
    var maxPending = 6

    private let queue = DispatchQueue(label: "nook.capture.writer", qos: .userInitiated)
    private let pendingLock = NSLock()
    private var pending = 0
    private lazy var ciContext = CIContext(options: [.cacheIntermediates: false])

    // Touched only on `queue`.
    private var frames: [[String: Any]] = []
    private var camera: Intrinsics?
    private var depthCount = 0
    private var positions: [Float] = []
    private var colors: [UInt8] = []
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
    func finish(floorY: Float?) throws -> CaptureSummary {
        try queue.sync {
            if let error { throw CaptureError.write(error.localizedDescription) }
            guard let camera, !frames.isEmpty else { throw CaptureError.noFrames }
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
                let meta: [String: Any] = [
                    "version": 1,
                    "app": "nook-scan",
                    "app_version": info.appVersion,
                    "device": info.device,
                    "lidar": info.lidar,
                    "world": "arkit-gravity-y-up-meters",
                    "created": iso.string(from: info.created),
                    "frame_count": frames.count,
                    "floor_y": floorY.map { Self.num($0) as Any } ?? NSNull(),
                ]
                try writeJSON(meta, to: "meta.json")
                return CaptureSummary(folder: folder, frameCount: frames.count, depthCount: depthCount,
                                      pointCount: pointCount, floorY: floorY)
            } catch {
                throw CaptureError.write(error.localizedDescription)
            }
        }
    }

    /// Waits for queued work and drops everything (used when a capture is discarded).
    func cancel() {
        queue.sync { error = CaptureError.noFrames }
    }

    // MARK: - Per keyframe (on `queue`)

    private func write(_ kf: Keyframe, index: Int, time: Double) throws {
        let name = String(format: "%06d", index)

        // Image: RGB, long side ≤ 1920, sensor orientation, JPEG 0.9.
        var image: CGImage
        switch kf.image {
        case .cgImage(let cg): image = cg
        case .pixelBuffer(let pb):
            let ci = CIImage(cvPixelBuffer: pb)
            guard let cg = ciContext.createCGImage(ci, from: ci.extent, format: .RGBA8, colorSpace: ImageUtils.sRGB) else {
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

        var frame: [String: Any] = [
            "file_path": "images/\(name).jpg",
            "transform_matrix": Self.rows(kf.transform),
            "timestamp": (time * 1000).rounded() / 1000,
        ]
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

    /// Back-projects every `seedStride`-th depth pixel into world space (OpenGL camera: +Y up, looking along −Z).
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
