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

/// Smoothed camera speed, for the "slow down" warning.
struct MotionMonitor {
    var maxSpeed: Float = 0.5          // m/s
    var maxAngularSpeed: Float = 60    // °/s
    private var last: (t: Double, m: simd_float4x4)?
    private(set) var speed: Float = 0
    private(set) var angularSpeed: Float = 0

    var isTooFast: Bool { speed > maxSpeed || angularSpeed > maxAngularSpeed }

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
