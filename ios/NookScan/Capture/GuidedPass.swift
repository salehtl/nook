import Foundation

/// How the phone is held: where it looks, and how high it is compared with the standard loop (nil until that's known).
struct Posture: Equatable {
    var pitchDegrees: Float
    var relativeHeight: Float? = nil
}

/// The guided scan (contract §4.13): three loops that see the room from different heights and angles, then a short
/// walk the trainer can hold back to score views it never saw.
enum ScanPass: Int, CaseIterable, Equatable {
    case standard = 1
    case giant = 2
    case ant = 3
    case testWalk = 4

    /// Meters above the standard loop's height that count as the high loop, and below it as the low loop.
    static let giantRise: Float = 0.15
    static let antDrop: Float = 0.35

    var title: String {
        switch self {
        case .standard: "Loop at chest height"
        case .giant: "High loop, tilted down"
        case .ant: "Low loop, tilted up"
        case .testWalk: "Test walk"
        }
    }

    /// Short name for the "still missing" list.
    var shortName: String {
        switch self {
        case .standard: "chest-height loop"
        case .giant: "high loop"
        case .ant: "low loop"
        case .testWalk: "test walk"
        }
    }

    /// What to do during this pass.
    var instruction: String {
        switch self {
        case .standard: "Walk slowly along the walls with the phone at chest height, level, pointing across the room."
        case .giant: "Walk the loop again with the phone above head height, tilted down at the floor and furniture."
        case .ant: "Walk the loop again with the phone at knee height, tilted up. Keep walls in view, not just the ceiling."
        case .testWalk: "Cross the room on a new route, looking around normally: first at seated height, then standing."
        }
    }

    var next: ScanPass? { ScanPass(rawValue: rawValue + 1) }

    /// The `pass` a frame records (contract §4.8 has 1, 2 and 3): test-walk frames are pass 3 with `test_walk: true`,
    /// so servers that don't know about the test walk still accept the capture.
    var contractNumber: Int { min(rawValue, 3) }

    /// Headings a pass must cover before it counts as done.
    var goodSectors: Int { self == .testWalk ? 6 : PassCoverage.goodSectors }

    /// Whether a keyframe held like this counts toward this pass's coverage.
    func counts(_ posture: Posture) -> Bool {
        let pitch = posture.pitchDegrees
        switch self {
        case .standard: return abs(pitch) <= 35
        case .giant: return pitch <= -15 && (posture.relativeHeight ?? Self.giantRise) >= Self.giantRise
        case .ant: return pitch >= 5 && pitch <= 65 && (posture.relativeHeight ?? -Self.antDrop) <= -Self.antDrop
        case .testWalk: return true
        }
    }

    /// A correction when the phone is held wrong for this pass, or nil. Height comes first: it's the bigger change.
    func postureHint(_ posture: Posture) -> String? {
        let pitch = posture.pitchDegrees
        switch self {
        case .standard:
            if pitch < -35 { return "Raise the phone: point it across the room" }
            if pitch > 35 { return "Lower the phone: point it across the room" }
        case .giant:
            if let h = posture.relativeHeight, h < Self.giantRise { return "Raise the phone above head height" }
            if pitch > -15 { return "Tilt the phone down toward the floor" }
        case .ant:
            if let h = posture.relativeHeight, h > -Self.antDrop { return "Lower the phone to knee height" }
            if pitch < 5 { return "Tilt the phone up toward the walls" }
            if pitch > 65 { return "Tilt down a little: keep walls in view" }
        case .testWalk:
            break
        }
        return nil
    }
}

/// The standard loop's average height, which the high and low loops are judged against.
struct HeightReference: Equatable {
    static let minSamples = 10
    private var sum: Float = 0
    private var count = 0

    mutating func add(_ y: Float) {
        sum += y
        count += 1
    }

    /// `y` relative to the standard loop, or nil while too few frames have set the reference.
    func relative(_ y: Float) -> Float? {
        count >= Self.minSamples ? y - sum / Float(count) : nil
    }
}

/// Heading coverage of one pass: twelve 30° sectors, each lit once a counted keyframe looked that way.
struct PassCoverage: Equatable {
    static let sectors = 12
    /// Sectors a loop needs before it counts as done (300° of the room).
    static let goodSectors = 10

    var needed = PassCoverage.goodSectors
    private(set) var lit = [Bool](repeating: false, count: PassCoverage.sectors)

    var count: Int { lit.filter { $0 }.count }
    var isGood: Bool { count >= needed }

    /// Lights the sector for heading `yaw` (radians, [0, 2π)). Returns true if it wasn't lit yet.
    @discardableResult
    mutating func add(yaw: Float) -> Bool {
        let i = Self.sector(yaw: yaw)
        guard !lit[i] else { return false }
        lit[i] = true
        return true
    }

    static func sector(yaw: Float) -> Int {
        let n = Float(sectors)
        let i = Int((yaw / (2 * .pi) * n).rounded(.down))
        return ((i % sectors) + sectors) % sectors
    }
}

/// The prompt under the frame counter: what to do next, given the current pass and its coverage.
struct PassGuide: Equatable {
    var pass: ScanPass = .standard
    var coverage: [PassCoverage] = ScanPass.allCases.map { PassCoverage(needed: $0.goodSectors) }

    var current: PassCoverage { coverage[pass.rawValue - 1] }

    /// Passes that haven't covered enough yet, for the check before finishing.
    var missing: [ScanPass] { ScanPass.allCases.filter { !coverage[$0.rawValue - 1].isGood } }

    /// Records a kept keyframe. Returns true if the coverage changed.
    @discardableResult
    mutating func add(yaw: Float, posture: Posture) -> Bool {
        guard pass.counts(posture) else { return false }
        return coverage[pass.rawValue - 1].add(yaw: yaw)
    }

    /// Moves to the next pass. Returns false after the last one.
    @discardableResult
    mutating func advance() -> Bool {
        guard let next = pass.next else { return false }
        pass = next
        return true
    }

    var prompt: String {
        let c = current
        guard c.isGood else {
            return c.count == 0 ? pass.instruction
                : "\(pass.instruction) \(c.count)/\(c.needed) directions so far."
        }
        switch pass {
        case .standard: return "Loop done. Tap Next pass, then raise the phone above head height and tilt it down."
        case .giant: return "High loop done. Tap Next pass, then lower the phone to knee height and tilt it up."
        case .ant: return "Low loop done. Tap Test walk, then cross the room on a new route."
        case .testWalk: return "All done. Tap Done to save."
        }
    }
}
