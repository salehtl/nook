import Foundation
import simd

enum FrameDecision: Equatable {
    case keep
    case notMoved
    case trackingLimited
    case blurry
    /// Exposure and white balance aren't locked yet (contract §4.8): nothing is kept before the lock.
    case waitingForLock
    /// The writer is behind; the frame is dropped so memory stays bounded.
    case busy
    case stopped
}

/// Decides which frames become keyframes: the phone moved ≥ 4 cm or turned ≥ 3° since the last keyframe
/// (contract §4.10), tracking is normal, and the image isn't blurry.
///
/// Blur is judged relative to recent frames (the median sharpness of the last candidates), with a small
/// absolute floor. A fixed threshold would reject sharp shots of plain walls, which have little texture.
struct KeyframeSelector {
    var spacing = KeyframeSpacing.standard
    var minSharpness: Float = 5
    var relativeSharpness: Float = 0.4
    var historySize = 30

    private(set) var lastKeyframe: simd_float4x4?
    private var history: [Float] = []

    /// Checks a frame without accepting it. `sharpness` is only evaluated for frames that moved enough.
    mutating func evaluate(transform: simd_float4x4, tracking: TrackingStatus, sharpness: () -> Float) -> FrameDecision {
        guard tracking.isNormal else { return .trackingLimited }
        if let last = lastKeyframe {
            let moved = simd_distance(Pose.position(last), Pose.position(transform))
            let turned = Pose.angleDegrees(last, transform)
            if moved < spacing.meters && turned < spacing.degrees { return .notMoved }
        }
        let s = sharpness()
        let threshold = max(minSharpness, relativeSharpness * median(history))
        history.append(s)
        if history.count > historySize { history.removeFirst(history.count - historySize) }
        return s >= threshold ? .keep : .blurry
    }

    /// Accepts the frame as the new reference for movement.
    mutating func commit(transform: simd_float4x4) {
        lastKeyframe = transform
    }

    private func median(_ values: [Float]) -> Float {
        guard !values.isEmpty else { return 0 }
        let s = values.sorted()
        return s[s.count / 2]
    }
}

/// Smoothed camera speed, for the "slow down" warning. Once the shutter is known (`exposure`, after the lock) the
/// warning is about blur rather than speed: how far the image moves while the shutter is open, at the main camera's
/// focal length in a 1920 px frame. At 1/1000 s you can move freely; at 1/100 s only slowly.
struct MotionMonitor {
    var maxSpeed: Float = 0.5          // m/s, before the shutter is known
    var maxAngularSpeed: Float = 60    // °/s, before the shutter is known
    /// Seconds the shutter is open, once locked.
    var exposure: Double?
    var maxBlurPixels: Float = 2
    /// °/s, whatever the shutter: a fast shutter stops motion blur, but the sensor still reads out top to bottom, so
    /// a fast turn skews the image (about 8 px across the frame at this speed and a 10 ms readout).
    var maxTurnSpeed: Float = 35
    static let focalPixels: Float = 1400   // main camera, 1920 px wide
    static let typicalDepth: Float = 1.5   // m: walking past a surface this far away
    private var last: (t: Double, m: simd_float4x4)?
    private(set) var speed: Float = 0
    private(set) var angularSpeed: Float = 0

    /// Predicted motion blur in pixels at the current speed, or nil before the shutter is known.
    var blurPixels: Float? {
        exposure.map { Self.focalPixels * Float($0) * (angularSpeed * .pi / 180 + speed / Self.typicalDepth) }
    }

    var isTooFast: Bool {
        if let blur = blurPixels { return blur > maxBlurPixels || angularSpeed > maxTurnSpeed }
        return speed > maxSpeed || angularSpeed > maxAngularSpeed
    }

    mutating func update(timestamp t: Double, transform m: simd_float4x4) {
        defer { last = (t, m) }
        guard let last, t > last.t else { return }
        let dt = Float(t - last.t)
        let v = simd_distance(Pose.position(last.m), Pose.position(m)) / dt
        let w = Pose.angleDegrees(last.m, m) / dt
        let a: Float = 0.15
        speed += a * (v - speed)
        angularSpeed += a * (w - angularSpeed)
    }
}
