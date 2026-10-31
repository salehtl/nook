import CoreGraphics
import CoreVideo
import Foundation
import simd

/// Tracking quality of a frame, independent of ARKit so replayed frames can carry it too.
enum TrackingStatus: Equatable {
    case normal
    case limited(String)
    case notAvailable

    var isNormal: Bool { self == .normal }

    /// Text for the tracking banner, or nil when tracking is fine.
    var message: String? {
        switch self {
        case .normal: return nil
        case .limited(let reason): return reason
        case .notAvailable: return "Tracking unavailable"
        }
    }
}

/// Pinhole intrinsics in pixels for an image of `width × height`.
struct Intrinsics: Equatable {
    var fx: Double
    var fy: Double
    var cx: Double
    var cy: Double
    var width: Int
    var height: Int

    /// The same camera for an image resized to `w × h` (contract §4.2: plain scaling).
    func scaled(toWidth w: Int, height h: Int) -> Intrinsics {
        let sx = Double(w) / Double(width), sy = Double(h) / Double(height)
        return Intrinsics(fx: fx * sx, fy: fy * sy, cx: cx * sx, cy: cy * sy, width: w, height: h)
    }
}

/// Metric depth at depth resolution, row-major, top row first. 0 means no data.
struct DepthMap {
    let width: Int
    let height: Int
    var meters: [Float]
    /// Per-pixel ARKit confidence (0 low, 1 medium, 2 high), or nil when unknown (replay).
    var confidence: [UInt8]?
}

/// Image pixels owned by the keyframe. Never ARKit's own buffer: that would stall the session.
enum FrameImage {
    case pixelBuffer(CVPixelBuffer)
    case cgImage(CGImage)
}

/// A high-resolution still (contract §4.10): ARKit's `captureHighResolutionFrame`, in sensor orientation, with
/// intrinsics for its own pixel size. Owned memory, like FrameImage.
struct Still {
    let image: CVPixelBuffer
    let intrinsics: Intrinsics
}

/// Minimum movement between keyframes (contract §4.10: 4 cm or 3°), recorded in meta.json `keyframe_spacing`.
struct KeyframeSpacing: Equatable {
    var meters: Float
    var degrees: Float

    static let standard = KeyframeSpacing(meters: 0.04, degrees: 3)
}

/// Everything the writer needs for one keyframe, copied out of the source frame.
struct Keyframe {
    let timestamp: Double
    /// Camera-to-world, OpenGL camera convention (ARCamera.transform as-is).
    let transform: simd_float4x4
    /// Intrinsics for the image at its native size.
    let intrinsics: Intrinsics
    let image: FrameImage
    let depth: DepthMap?
    /// Exposure time in seconds and exposure offset in EV, from ARCamera (contract §4.8). nil for replayed frames.
    var exposureDuration: Double? = nil
    var exposureOffset: Double? = nil
    /// Guided pass the frame was taken in, set by CaptureRecorder.
    var pass: ScanPass? = nil
    /// The high-resolution still taken at this frame's moment, if any. Its pose is `transform`.
    var still: Still? = nil
}

/// A frame as a source delivers it. It is only valid during the `onFrame` callback: anything kept must be
/// copied out through `makeKeyframe()`.
protocol CaptureFrame {
    var timestamp: Double { get }
    var transform: simd_float4x4 { get }
    var tracking: TrackingStatus { get }
    /// Image sharpness (variance of the Laplacian of the luma, see ImageUtils). Only called for candidates.
    func sharpness() -> Float
    /// Copies the image, intrinsics and depth into owned memory.
    func makeKeyframe() -> Keyframe?
}

/// Where frames come from: ARKit on a device, or a recorded capture folder (simulator and tests).
/// Both feed the same CaptureRecorder (KeyframeSelector + CaptureWriter).
protocol CaptureSource: AnyObject {
    /// Shown in meta.json `device`.
    var deviceName: String { get }
    /// Whether frames carry LiDAR depth (meta.json `lidar`).
    var hasDepth: Bool { get }
    /// Height of the floor (lowest large horizontal plane) once known.
    var floorY: Float? { get }
    /// Vertical planes seen so far, in capture world (for lining up a RoomPlan pass, contract §4.12).
    var wallPlanes: [WallPlane] { get }
    /// Starts delivering frames on a background queue. `onFrame` is called serially and must not keep the frame.
    /// `onEnd` is called when a finite source runs out (replay). A live source never ends on its own.
    func start(onFrame: @escaping (CaptureFrame) -> Void, onEnd: @escaping () -> Void)
    /// Stops frames and, for a live camera, unlocks exposure and white balance.
    func stop()
    /// Whether the source has a camera whose exposure and white balance can be locked (contract §4.8).
    var canLockCamera: Bool { get }
    /// Locks exposure and white balance at their current values and reports what was locked.
    /// Called on the frame queue, once tracking has settled.
    func lockCamera() -> CameraLock
    /// Whether the source can take high-resolution stills (contract §4.10).
    var canCaptureStills: Bool { get }
    /// Takes one still without blocking the caller. `completion` runs once, on any queue, with a keyframe built
    /// from the high-resolution frame (its own pose, timestamp and depth, image and `still` set), or nil if the
    /// still failed or can't be trusted (e.g. it left the exposure lock).
    func captureStill(completion: @escaping (Keyframe?) -> Void)
}

extension CaptureSource {
    var wallPlanes: [WallPlane] { [] }
    var canLockCamera: Bool { false }
    func lockCamera() -> CameraLock { .none }
    var canCaptureStills: Bool { false }
    func captureStill(completion: @escaping (Keyframe?) -> Void) { completion(nil) }
}

enum FloorEstimator {
    /// floor_y: the lowest horizontal plane with an area of at least `minArea` m², or nil.
    static func floorY(planes: [(y: Float, area: Float)], minArea: Float = 1) -> Float? {
        planes.filter { $0.area >= minArea }.map(\.y).min()
    }
}

enum Pose {
    static func position(_ m: simd_float4x4) -> SIMD3<Float> {
        SIMD3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
    }

    /// Angle in degrees of the relative rotation between two poses.
    static func angleDegrees(_ a: simd_float4x4, _ b: simd_float4x4) -> Float {
        // trace(Raᵀ Rb) = Σ columns dot products
        let t = simd_dot(a.columns.0.xyz, b.columns.0.xyz)
            + simd_dot(a.columns.1.xyz, b.columns.1.xyz)
            + simd_dot(a.columns.2.xyz, b.columns.2.xyz)
        let c = max(-1, min(1, (t - 1) / 2))
        return acos(c) * 180 / .pi
    }

    /// How far the camera looks up (+) or down (−) from level, in degrees.
    static func pitchDegrees(_ m: simd_float4x4) -> Float {
        let f = simd_normalize(-m.columns.2.xyz)
        return asin(max(-1, min(1, f.y))) * 180 / .pi
    }

    /// Camera heading in [0, 2π): the direction the camera looks (−Z), projected on the floor.
    static func yaw(_ m: simd_float4x4) -> Float {
        let f = -m.columns.2.xyz
        let a = atan2(f.x, -f.z)
        return a < 0 ? a + 2 * .pi : a
    }
}

extension SIMD4 where Scalar == Float {
    var xyz: SIMD3<Float> { SIMD3(x, y, z) }
}

enum DeviceInfo {
    /// Model identifier such as "iPhone17,1".
    static var model: String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim }
        var u = utsname()
        uname(&u)
        return withUnsafeBytes(of: &u.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
    }

    /// How hot the phone is, for the record of how a capture ended.
    static var thermalState: String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }

    static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }
}
