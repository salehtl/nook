import Foundation

/// What the user chose for the camera, before a scan starts. Once the scan starts these are locked, so every frame
/// shares one exposure (contract §4.14).
struct CameraSettings: Equatable, Codable {
    /// 1/`shutterDenominator` s; 0 is Auto: the fastest shutter the light allows, with flicker detection.
    var shutterDenominator = 0
    /// nil matches auto exposure's brightness at the chosen shutter.
    var iso: Double?
    /// High-resolution stills. Off is video frames only: nothing can click.
    var takeStills = true

    static let shutterChoices = [0, 100, 120, 250, 500, 1000]
    static let key = "cameraSettings"

    var isAuto: Bool { shutterDenominator == 0 && iso == nil }

    static var current: CameraSettings {
        get {
            guard let data = UserDefaults.standard.data(forKey: key),
                  let s = try? JSONDecoder().decode(CameraSettings.self, from: data) else { return CameraSettings() }
            return s
        }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: key) }
    }

    /// The exposure to lock, given what auto exposure metered and what the camera's format allows.
    func exposure(meteredDuration: Double, meteredISO: Double, isoRange: ClosedRange<Double>,
                  durationRange: ClosedRange<Double>) -> AdaptiveShutter.Exposure {
        if isAuto {
            return AdaptiveShutter.exposure(duration: meteredDuration, iso: meteredISO,
                                            minISO: isoRange.lowerBound, maxISO: isoRange.upperBound)
        }
        let light = meteredDuration * meteredISO
        var duration = shutterDenominator > 0 ? 1 / Double(shutterDenominator) : light / (iso ?? meteredISO)
        duration = min(max(duration, durationRange.lowerBound), durationRange.upperBound)
        let wantedISO = iso ?? (duration > 0 ? light / duration : meteredISO)
        let chosenISO = min(max(wantedISO, isoRange.lowerBound), isoRange.upperBound)
        // More than a fifth darker than auto exposure's picture: say so.
        return AdaptiveShutter.Exposure(duration: duration, iso: chosenISO, tooDark: duration * chosenISO < light * 0.8)
    }
}

/// How much brightness jumps from one frame to the next while the phone holds still. Nothing in the room changes in
/// that time, so a jump is the lights flickering. A real scan under LEDs at 1/257 s jumped 0.23 EV between
/// neighbouring frames, and a daylight scan 0.02 EV. 60 Hz mains can slip through: its 120 Hz flicker lands on the same
/// phase of every frame at 30 or 60 fps, so nothing jumps (1/120 s in the settings covers it).
struct FlickerMeter {
    static let flickerEV: Float = 0.06
    static let minSamples = 20
    private var lumas: [Float] = []

    mutating func add(_ luma: Float) {
        if luma > 1 { lumas.append(luma) }
    }

    var isReady: Bool { lumas.count >= Self.minSamples }

    /// Median jump between consecutive frames, in EV.
    var jitterEV: Float {
        guard lumas.count >= 2 else { return 0 }
        let jumps = zip(lumas, lumas.dropFirst()).map { abs(log2($0 / $1)) }.sorted()
        return jumps[jumps.count / 2]
    }
}

/// Auto's flicker check, run on still frames right after the lock: measure at the fast shutter; if the lights flicker,
/// try the shutters that cover a whole flicker (1/100 s on 50 Hz mains, 1/120 s on 60 Hz) and keep the steadiest.
struct FlickerProbe {
    enum Action: Equatable {
        case wait
        /// Lock this shutter (seconds), then keep feeding frames.
        case relock(Double)
        /// Finished. `shutter` is the flicker-safe shutter in use, or nil if the lights are steady.
        case done(shutter: Double?, measuredEV: Float)
    }

    static let safeShutters = [1.0 / 100, 1.0 / 120]
    /// Seconds a new shutter takes to reach the frames.
    static let settleSeconds = 0.2

    private var meter = FlickerMeter()
    private var settleUntil: Double?
    private var firstEV: Float?
    private var triedShutter: Double?
    private var results: [(shutter: Double, ev: Float)] = []

    /// The jump measured at the fast shutter, once flicker was found.
    var measuredEV: Float? { firstEV }

    mutating func add(luma: Float, timestamp: Double) -> Action {
        if let until = settleUntil {
            if timestamp < until { return .wait }
            settleUntil = nil
        }
        meter.add(luma)
        guard meter.isReady else { return .wait }
        let ev = meter.jitterEV
        meter = FlickerMeter()
        if let tried = triedShutter {
            if ev <= FlickerMeter.flickerEV { return .done(shutter: tried, measuredEV: firstEV ?? ev) }
            results.append((tried, ev))
        } else {
            if ev <= FlickerMeter.flickerEV { return .done(shutter: nil, measuredEV: ev) }
            firstEV = ev
        }
        if results.count < Self.safeShutters.count {
            let next = Self.safeShutters[results.count]
            triedShutter = next
            settleUntil = timestamp + Self.settleSeconds
            return .relock(next)
        }
        // Neither was steady: finish on the steadier one, whichever is locked now.
        let best = results.min { $0.ev < $1.ev }?.shutter ?? Self.safeShutters[0]
        return .done(shutter: best, measuredEV: firstEV ?? ev)
    }
}
