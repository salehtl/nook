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
    /// The shutter had to stay slower than `AdaptiveShutter.slowest`: the room is too dark for sharp frames.
    var tooDark = false

    static let none = CameraLock()

    var isAnyLocked: Bool { exposureLocked || whiteBalanceLocked }
    var isFullyLocked: Bool { exposureLocked && whiteBalanceLocked }
}

/// The exposure to lock: auto exposure's brightness (shutter × ISO), at the fastest shutter the light allows. Splat
/// training averages sensor noise away across hundreds of views but learns motion blur, so the trade always favours
/// a faster shutter. Indoors auto exposure settles near 1/100 s, where a phone turning at 12°/s smears a frame by
/// about 3 px:
/// 1. The fastest shutter down to `fastest` (1/1000 s) that keeps ISO within `isoBudget`: a bright room lands near
///    1/1000 s, an ordinary one in between.
/// 2. If that is slower than `slowest` (1/250 s), ISO goes up to the format's maximum to hold `slowest`.
/// 3. If even that can't hold it, the shutter lengthens just enough (`tooDark`: the room needs more light).
/// Never slower than auto exposure's own shutter.
enum AdaptiveShutter {
    static let fastest = 1.0 / 1000
    static let slowest = 1.0 / 250
    /// Where video-frame noise starts to cost more than it saves; a first guess, to be checked on a real scan.
    static let isoBudget = 800.0

    struct Exposure: Equatable {
        var duration: Double
        var iso: Double
        /// Even the format's maximum ISO couldn't hold `slowest`.
        var tooDark: Bool
    }

    static func exposure(duration: Double, iso: Double, minISO: Double, maxISO: Double) -> Exposure {
        guard duration > 0, iso > 0, maxISO >= minISO else { return Exposure(duration: duration, iso: iso, tooDark: false) }
        let light = duration * iso
        func at(_ iso: Double) -> Exposure {
            let i = min(max(iso, minISO), maxISO)
            return Exposure(duration: light / i, iso: i, tooDark: false)
        }
        var e = at(min(isoBudget, maxISO))
        if e.duration < fastest { e = at(light / fastest) }   // bright: 1/1000 s at a lower ISO
        if e.duration > slowest { e = at(light / slowest) }   // dim: past the budget, up to the maximum ISO
        e.tooDark = e.duration > slowest * 1.001
        if e.duration >= duration { return Exposure(duration: duration, iso: iso, tooDark: e.tooDark) }
        return e
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
