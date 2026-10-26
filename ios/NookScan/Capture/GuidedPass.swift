import Foundation

/// The three guided passes of a scan (contract §4.8 `pass`). Each frame records the pass it was taken in.
enum ScanPass: Int, CaseIterable, Equatable {
    case chest = 1
    case low = 2
    case middle = 3

    var title: String {
        switch self {
        case .chest: "Loop at chest height"
        case .low: "Lower loop, phone tilted down"
        case .middle: "Walk through the middle"
        }
    }

    /// What to do during this pass.
    var instruction: String {
        switch self {
        case .chest: "Walk slowly along the walls with the phone at chest height, pointing across the room."
        case .low: "Walk the loop again with the phone at waist height, tilted down toward the floor and furniture."
        case .middle: "Walk slowly through the middle of the room, turning to face each wall."
        }
    }

    var next: ScanPass? { ScanPass(rawValue: rawValue + 1) }

    /// Whether a keyframe looking `pitch` degrees up (+) or down (−) counts toward this pass's coverage.
    func counts(pitchDegrees pitch: Float) -> Bool {
        switch self {
        case .chest, .middle: pitch > -45
        case .low: pitch <= -15
        }
    }

    /// A correction when the phone is held wrong for this pass, or nil.
    func postureHint(pitchDegrees pitch: Float) -> String? {
        switch self {
        case .chest, .middle: pitch <= -45 ? "Raise the phone: point it across the room" : nil
        case .low: pitch > -15 ? "Tilt the phone down toward the floor" : nil
        }
    }
}

/// Heading coverage of one pass: twelve 30° sectors, each lit once a counted keyframe looked that way.
struct PassCoverage: Equatable {
    static let sectors = 12
    /// Sectors needed before the pass counts as done (300° of the room).
    static let goodSectors = 10

    private(set) var lit = [Bool](repeating: false, count: PassCoverage.sectors)

    var count: Int { lit.filter { $0 }.count }
    var isGood: Bool { count >= Self.goodSectors }

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
    var pass: ScanPass = .chest
    var coverage: [PassCoverage] = Array(repeating: PassCoverage(), count: ScanPass.allCases.count)

    var current: PassCoverage { coverage[pass.rawValue - 1] }

    /// Records a kept keyframe. Returns true if the coverage changed.
    @discardableResult
    mutating func add(yaw: Float, pitchDegrees: Float) -> Bool {
        guard pass.counts(pitchDegrees: pitchDegrees) else { return false }
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
                : "\(pass.instruction) \(c.count)/\(PassCoverage.sectors) directions so far."
        }
        switch pass {
        case .chest: return "Loop done. Tap Next pass, then lower the phone to waist height and tilt it down."
        case .low: return "Lower loop done. Tap Next pass, then walk slowly through the middle of the room."
        case .middle: return "All three passes done. Tap Done to save."
        }
    }
}
