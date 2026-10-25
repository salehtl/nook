import ARKit
import Foundation

/// ARKit world tracking with gravity alignment, LiDAR scene depth when the device has it, and horizontal plane
/// detection for floor_y. Frames are handled on a private delegate queue and never retained.
final class LiveCaptureSource: NSObject, CaptureSource, ARSessionDelegate {
    enum Issue {
        /// The session can't run (e.g. camera access denied). `needsSettings`: the fix is in the Settings app.
        case failed(String, needsSettings: Bool)
        /// The camera was taken away (call, app switch). Frames after this may sit in a shifted world frame.
        case interrupted
    }

    let session = ARSession()
    private let queue = DispatchQueue(label: "nook.capture.arkit", qos: .userInteractive)
    private var onFrame: ((CaptureFrame) -> Void)?
    /// Called on the delegate queue.
    var onIssue: ((Issue) -> Void)?
    private let lock = NSLock()
    private var planes: [UUID: (y: Float, area: Float)] = [:]

    static var isSupported: Bool { ARWorldTrackingConfiguration.isSupported }

    let deviceName = DeviceInfo.model
    let hasDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)

    var floorY: Float? {
        lock.lock(); defer { lock.unlock() }
        return FloorEstimator.floorY(planes: Array(planes.values))
    }

    func start(onFrame: @escaping (CaptureFrame) -> Void, onEnd: @escaping () -> Void) {
        self.onFrame = onFrame
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity
        config.planeDetection = [.horizontal]
        if hasDepth { config.frameSemantics.insert(.sceneDepth) }
        session.delegate = self
        session.delegateQueue = queue
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    func stop() {
        session.pause()
        queue.sync { onFrame = nil }
    }

    // MARK: ARSessionDelegate (on `queue`)

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        onFrame?(ARCaptureFrame(frame: frame))
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        let denied = (error as? ARError)?.code == .cameraUnauthorized
        onIssue?(.failed(denied ? "Camera access is off. Turn it on in Settings › Nook Scan › Camera."
                                : "ARKit stopped: \(error.localizedDescription)", needsSettings: denied))
    }

    func sessionWasInterrupted(_ session: ARSession) { onIssue?(.interrupted) }

    // Relocalizing after an interruption can still leave the world frame shifted; the capture stops instead.
    func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { false }

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) { updatePlanes(anchors) }
    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) { updatePlanes(anchors) }

    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        lock.lock(); defer { lock.unlock() }
        for a in anchors { planes[a.identifier] = nil }
    }

    private func updatePlanes(_ anchors: [ARAnchor]) {
        lock.lock(); defer { lock.unlock() }
        for case let p as ARPlaneAnchor in anchors where p.alignment == .horizontal {
            let center = p.transform * SIMD4<Float>(p.center, 1)
            planes[p.identifier] = (center.y, p.planeExtent.width * p.planeExtent.height)
        }
    }
}

/// Wraps an ARFrame for the duration of the delegate callback only.
private struct ARCaptureFrame: CaptureFrame {
    let frame: ARFrame

    var timestamp: Double { frame.timestamp }
    var transform: simd_float4x4 { frame.camera.transform }

    var tracking: TrackingStatus {
        switch frame.camera.trackingState {
        case .normal: return .normal
        case .notAvailable: return .notAvailable
        case .limited(let reason):
            switch reason {
            case .initializing: return .limited("Starting up: move the phone slowly")
            case .excessiveMotion: return .limited("Moving too fast: slow down")
            case .insufficientFeatures: return .limited("Not enough detail: add light or aim at textured areas")
            case .relocalizing: return .limited("Relocalizing: return to where you were")
            @unknown default: return .limited("Tracking limited")
            }
        }
    }

    func sharpness() -> Float {
        ImageUtils.sharpness(ofLumaPlaneOf: frame.capturedImage)
    }

    func makeKeyframe() -> Keyframe? {
        guard let image = ImageUtils.copyPixelBuffer(frame.capturedImage) else { return nil }
        let res = frame.camera.imageResolution
        let k = frame.camera.intrinsics   // column-major: [0][0] fx, [1][1] fy, [2][0] cx, [2][1] cy
        let intrinsics = Intrinsics(fx: Double(k[0][0]), fy: Double(k[1][1]), cx: Double(k[2][0]), cy: Double(k[2][1]),
                                    width: Int(res.width), height: Int(res.height))
        return Keyframe(timestamp: frame.timestamp, transform: frame.camera.transform, intrinsics: intrinsics,
                        image: .pixelBuffer(image), depth: frame.sceneDepth.flatMap(Self.copyDepth))
    }

    /// Copies sceneDepth (Float32 meters) and its confidence. Low-confidence pixels become 0 (no data).
    private static func copyDepth(_ d: ARDepthData) -> DepthMap? {
        let map = d.depthMap
        guard CVPixelBufferGetPixelFormatType(map) == kCVPixelFormatType_DepthFloat32 else { return nil }
        let w = CVPixelBufferGetWidth(map), h = CVPixelBufferGetHeight(map)
        var meters = [Float](repeating: 0, count: w * h)
        CVPixelBufferLockBaseAddress(map, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(map) else { return nil }
        let rowBytes = CVPixelBufferGetBytesPerRow(map)
        for y in 0..<h {
            let row = (base + y * rowBytes).assumingMemoryBound(to: Float32.self)
            for x in 0..<w { meters[y * w + x] = row[x] }
        }
        var confidence: [UInt8]?
        if let c = d.confidenceMap, CVPixelBufferGetWidth(c) == w, CVPixelBufferGetHeight(c) == h {
            CVPixelBufferLockBaseAddress(c, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(c, .readOnly) }
            if let cb = CVPixelBufferGetBaseAddress(c) {
                let cRow = CVPixelBufferGetBytesPerRow(c)
                var conf = [UInt8](repeating: 0, count: w * h)
                for y in 0..<h {
                    let row = (cb + y * cRow).assumingMemoryBound(to: UInt8.self)
                    for x in 0..<w {
                        conf[y * w + x] = row[x]
                        if row[x] == UInt8(ARConfidenceLevel.low.rawValue) { meters[y * w + x] = 0 }
                    }
                }
                confidence = conf
            }
        }
        return DepthMap(width: w, height: h, meters: meters, confidence: confidence)
    }
}
