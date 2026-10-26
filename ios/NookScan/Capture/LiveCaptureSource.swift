import ARKit
import AVFoundation
import Foundation
import os

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
    /// What `lockCamera` locked, for checking stills against it. Guarded by `lock`.
    private var cameraLock = CameraLock.none
    /// Stills are copied and checked here, never on the delegate queue.
    private let stillQueue = DispatchQueue(label: "nook.capture.stills", qos: .userInitiated)
    private static let log = Logger(subsystem: "com.salehtl.nookscan", category: "stills")

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
        // The format ARKit recommends for stills (e.g. 1920 × 1440 video with 12 MP stills). Without it a still may
        // be no larger than the video frame.
        if let format = ARWorldTrackingConfiguration.recommendedVideoFormatForHighResolutionFrameCapturing {
            config.videoFormat = format
        }
        session.delegate = self
        session.delegateQueue = queue
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    func stop() {
        unlockCamera()
        session.pause()
        queue.sync { onFrame = nil }
    }

    // MARK: Exposure and white balance (contract §4.8)

    var canLockCamera: Bool { true }

    /// Locks exposure and white balance of ARKit's camera at their current values. Autofocus stays on: per-frame
    /// intrinsics already follow it.
    func lockCamera() -> CameraLock {
        guard let device = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera else { return .none }
        do { try device.lockForConfiguration() } catch { return .none }
        defer { device.unlockForConfiguration() }
        var lock = CameraLock()
        if device.isExposureModeSupported(.locked) {
            device.exposureMode = .locked
            lock.exposureLocked = true
            lock.iso = Double(device.iso)
            lock.exposureDuration = device.exposureDuration.seconds
        }
        if device.isWhiteBalanceModeSupported(.locked) {
            device.whiteBalanceMode = .locked
            lock.whiteBalanceLocked = true
            let g = device.deviceWhiteBalanceGains
            lock.whiteBalanceGains = WhiteBalanceGains(r: Double(g.redGain), g: Double(g.greenGain), b: Double(g.blueGain))
        }
        self.lock.lock(); cameraLock = lock; self.lock.unlock()
        return lock
    }

    /// Back to continuous auto exposure and white balance.
    private func unlockCamera() {
        lock.lock(); cameraLock = .none; lock.unlock()
        guard let device = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera,
              (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }
        if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
        if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { device.whiteBalanceMode = .continuousAutoWhiteBalance }
    }

    // MARK: High-resolution stills (contract §4.10)
    //
    // ARKit takes stills through the same AVCaptureDevice it hands out as `configurableCaptureDeviceForPrimaryCamera`,
    // and a photo capture on a device whose exposure and white balance are `.locked` doesn't run its own metering.
    // What can still change a still's look is the photo pipeline itself: flash and multi-frame fusion (Smart HDR,
    // Deep Fusion). On iOS 26 the still's photo settings turn both off. On every version each still is checked
    // before it's used: the device must still be locked and the still's exposure time must match the lock. A still
    // that fails is dropped (its keyframe keeps the video frame) and the lock is put back if something undid it.

    var canCaptureStills: Bool {
        ARWorldTrackingConfiguration.recommendedVideoFormatForHighResolutionFrameCapturing != nil
    }

    func captureStill(completion: @escaping (Keyframe?) -> Void) {
        let handler: (ARFrame?, Error?) -> Void = { [weak self] frame, error in
            // Possibly on the delegate queue: hop off before copying 12 MP.
            guard let self, let frame else {
                Self.log.info("still failed: \(error?.localizedDescription ?? "no frame", privacy: .public)")
                return completion(nil)
            }
            stillQueue.async { completion(self.keyframe(fromStill: frame)) }
        }
        if #available(iOS 26, *), let format = session.configuration?.videoFormat {
            let settings = format.defaultPhotoSettings
            settings.flashMode = .off
            settings.photoQualityPrioritization = .speed
            session.captureHighResolutionFrame(using: settings, completion: handler)
        } else {
            session.captureHighResolutionFrame(completion: handler)
        }
    }

    /// The keyframe for a still, or nil if the still can't be trusted (tracking, exposure lock) or copied.
    private func keyframe(fromStill frame: ARFrame) -> Keyframe? {
        guard frame.camera.trackingState == .normal else {
            Self.log.info("still dropped: tracking not normal")
            return nil
        }
        if let reason = lockViolation(frame) {
            Self.log.error("still dropped: \(reason, privacy: .public)")
            reassertLock()
            return nil
        }
        guard var kf = ARCaptureFrame(frame: frame).makeKeyframe() else { return nil }
        if case .pixelBuffer(let image) = kf.image { kf.still = Still(image: image, intrinsics: kf.intrinsics) }
        return kf
    }

    /// Why a still isn't under the exposure and white-balance lock, or nil if it is (or nothing was locked).
    private func lockViolation(_ frame: ARFrame) -> String? {
        lock.lock(); let locked = cameraLock; lock.unlock()
        guard locked.isAnyLocked, let device = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera else { return nil }
        if locked.exposureLocked {
            guard device.exposureMode == .locked || device.exposureMode == .custom else { return "exposure no longer locked" }
            if let d = locked.exposureDuration, d > 0, abs(frame.camera.exposureDuration - d) > 0.05 * d {
                return "exposure \(frame.camera.exposureDuration) s, locked at \(d) s"
            }
        }
        if locked.whiteBalanceLocked, device.whiteBalanceMode != .locked { return "white balance no longer locked" }
        return nil
    }

    /// Puts the recorded exposure and white-balance values back if a still knocked the device out of its lock.
    private func reassertLock() {
        lock.lock(); let locked = cameraLock; lock.unlock()
        guard let device = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera,
              (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }
        if locked.exposureLocked, device.exposureMode != .locked, device.exposureMode != .custom,
           device.isExposureModeSupported(.custom), let d = locked.exposureDuration, let iso = locked.iso {
            let f = device.activeFormat
            let duration = CMTimeClampToRange(CMTime(seconds: d, preferredTimescale: 1_000_000_000),
                                              range: CMTimeRange(start: f.minExposureDuration, end: f.maxExposureDuration))
            device.setExposureModeCustom(duration: duration, iso: min(max(Float(iso), f.minISO), f.maxISO))
        }
        if locked.whiteBalanceLocked, device.whiteBalanceMode != .locked, let g = locked.whiteBalanceGains {
            let clamp = { (x: Double) in min(max(Float(x), 1), device.maxWhiteBalanceGain) }
            device.setWhiteBalanceModeLocked(with: AVCaptureDevice.WhiteBalanceGains(redGain: clamp(g.r), greenGain: clamp(g.g), blueGain: clamp(g.b)))
        }
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
        // The camera's intrinsics are for `imageResolution`. For a still that should be the buffer's own size; if
        // it ever isn't, scale them to the pixels actually stored.
        let intrinsics = Intrinsics(fx: Double(k[0][0]), fy: Double(k[1][1]), cx: Double(k[2][0]), cy: Double(k[2][1]),
                                    width: Int(res.width), height: Int(res.height))
            .scaled(toWidth: CVPixelBufferGetWidth(image), height: CVPixelBufferGetHeight(image))
        return Keyframe(timestamp: frame.timestamp, transform: frame.camera.transform, intrinsics: intrinsics,
                        image: .pixelBuffer(image), depth: frame.sceneDepth.flatMap(Self.copyDepth),
                        exposureDuration: frame.camera.exposureDuration,
                        exposureOffset: Double(frame.camera.exposureOffset))
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
