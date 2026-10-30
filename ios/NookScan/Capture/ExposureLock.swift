import Foundation

/// White-balance gains as AVCaptureDevice reports them (device RGB gains).
struct WhiteBalanceGains: Equatable {
    var r: Double
    var g: Double
    var b: Double
}

/// What locking the camera achieved, recorded in meta.json (contract §4.8).
struct CameraLock: Equatable {
    var exposureLocked = false
    var whiteBalanceLocked = false
    var iso: Double?
    /// Seconds.
    var exposureDuration: Double?
    var whiteBalanceGains: WhiteBalanceGains?

    static let none = CameraLock()

    var isAnyLocked: Bool { exposureLocked || whiteBalanceLocked }
    var isFullyLocked: Bool { exposureLocked && whiteBalanceLocked }
}

/// The exposure to lock: auto exposure's brightness, at a shutter no slower than `maxDuration`. Indoors auto exposure
/// settles near 1/100 s, and a phone turning at 12°/s smears a 1/100 s frame by about 3 px (11 px at 40°/s); splat
/// training averages sensor noise away across views but learns blur. So the shutter is shortened and ISO raised to
/// keep the same exposure. When ISO would pass `maxISO`, ISO stops there and the shutter lengthens just enough.
enum ShutterCap {
    /// 1/250 s: 2.5× less motion blur than auto exposure's usual indoor 1/100 s, at 2.5× the ISO.
    static let maxDuration = 1.0 / 250

    static func exposure(duration: Double, iso: Double, maxDuration: Double = maxDuration,
                         minISO: Double, maxISO: Double) -> (duration: Double, iso: Double) {
        guard duration > maxDuration, duration > 0, iso > 0 else { return (duration, iso) }
        let light = duration * iso
        let newISO = min(maxISO, max(minISO, light / maxDuration))
        return (min(duration, light / newISO), newISO)
    }
}

/// When to lock exposure and white balance (contract §4.8): once tracking has been normal for about a second,
/// so auto exposure has settled on the room. No keyframes are kept before the lock is in place, so every image
/// in the capture shares one exposure and one white balance.
///
/// If the camera can't be locked, frames are kept anyway with auto exposure: a capture with drifting exposure
/// is still better than none. A source without a camera (replay) skips the lock entirely.
struct ExposureLockPolicy: Equatable {
    enum State: Equatable {
        /// Waiting for tracking to settle. `normalSince` is when the current run of normal tracking began.
        case settling(normalSince: Double?)
        /// The caller was told to lock and hasn't reported back yet.
        case locking
        /// Exposure, white balance, or both are locked. Keyframes are kept.
        case locked(CameraLock)
        /// Locking was attempted and nothing could be locked. Keyframes are kept with auto exposure.
        case unlockable
        /// The source has no camera to lock (replay). Keyframes are kept as they come.
        case notApplicable
    }

    let settleSeconds: Double
    private(set) var state: State

    init(canLock: Bool, settleSeconds: Double = 1) {
        self.settleSeconds = settleSeconds
        state = canLock ? .settling(normalSince: nil) : .notApplicable
    }

    /// Feeds one frame's tracking state. Returns true exactly once: when the caller should lock the camera now
    /// and report the outcome through `didLock(_:)`.
    mutating func shouldLock(tracking: TrackingStatus, timestamp: Double) -> Bool {
        guard case .settling(let since) = state else { return false }
        guard tracking.isNormal else {
            state = .settling(normalSince: nil)
            return false
        }
        guard let since else {
            state = .settling(normalSince: timestamp)
            return false
        }
        guard timestamp - since >= settleSeconds else { return false }
        state = .locking
        return true
    }

    mutating func didLock(_ lock: CameraLock) {
        guard state == .locking else { return }
        state = lock.isAnyLocked ? .locked(lock) : .unlockable
    }

    /// Whether keyframes may be kept yet.
    var allowsKeyframes: Bool {
        switch state {
        case .settling, .locking: false
        case .locked, .unlockable, .notApplicable: true
        }
    }

    /// What goes into meta.json.
    var record: CameraLock {
        if case .locked(let lock) = state { return lock }
        return .none
    }
}
