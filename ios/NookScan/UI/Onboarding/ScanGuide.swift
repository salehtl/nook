import Foundation

/// The scanning guides (prepare, lock the light, the three loops, the test walk, the room shell). Their text is taken word for word from
/// docs/SCANNING.md, so the app and the written guide never disagree (OnboardingTests checks it).
enum ScanGuide: Int, CaseIterable, Identifiable {
    case prepare
    case lockLight
    case pass1
    case pass2
    case pass3
    case testWalk
    /// The RoomPlan pass (contract §4.12): only on phones with LiDAR, see `visible(lidar:)`.
    case roomShell

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .prepare: "Prepare the room"
        case .lockLight: "Lock the light"
        case .pass1: "Pass 1: chest height, level"
        case .pass2: "Pass 2: up high, tilted down"
        case .pass3: "Pass 3: down low, tilted up"
        case .testWalk: "Test walk"
        case .roomShell: "Room shell (LiDAR phones)"
        }
    }

    var systemImage: String {
        switch self {
        case .prepare: "sun.max"
        case .lockLight: "lock"
        case .pass1: "1.circle"
        case .pass2: "2.circle"
        case .pass3: "3.circle"
        case .testWalk: "figure.walk"
        case .roomShell: "cube.transparent"
        }
    }

    /// Sentences from docs/SCANNING.md (markdown bold removed).
    var lines: [String] {
        switch self {
        case .prepare:
            ["Anything left in the room is baked into the scan.",
             "Even light: daytime, curtains open but no harsh sun patches. Lighting is baked into the splat, so this is the light you'll see in the planner.",
             "Close cupboard doors, and tidy cables and things on the walls.",
             "Keep people and pets out of the room.",
             "Turn on Do Not Disturb: a call ends the scan."]
        case .lockLight:
            ["The app locks exposure and white balance about a second into the scan, so start facing a typical part of the room, not the window.",
             "New Scan. Hold the phone steady until the lock icon shows (exposure and white balance locked)."]
        case .pass1:
            ["Pass 1: walk the perimeter slowly at chest height, with the phone level, looking across the room.",
             "Walk at a slow stroll, and never spin on the spot: turn as you walk, about 20 seconds for a full turn."]
        case .pass2:
            ["Pass 2: walk the loop again with the phone above head height, tilted down, so the floor and furniture tops are covered."]
        case .pass3:
            ["Pass 3: walk the loop again with the phone at knee height, tilted up, keeping walls in view, not just the ceiling.",
             "The app tells you when each pass has covered enough of the room, and when to raise, lower or tilt the phone."]
        case .testWalk:
            ["Test walk: cross the room on a new route, looking around normally, first at seated height, then standing.",
             "These frames are how the room gets scored."]
        case .roomShell:
            ["Room shell (phones with LiDAR): the app then measures the room's walls, floor, doors and windows with RoomPlan, in about a minute.",
             "From where you are, sweep the phone slowly across every wall, corner, door and window.",
             "Skip keeps the scan without it; turn it off in Settings › Measure the room shell."]
        }
    }

    /// The guides this phone shows: the room shell only where RoomPlan runs (LiDAR).
    static func visible(lidar: Bool = RoomPlanSettings.isSupported) -> [ScanGuide] {
        allCases.filter { $0 != .roomShell || lidar }
    }

    /// The guide for a capture pass, for the in-pass strip.
    static func forPass(_ pass: ScanPass) -> ScanGuide {
        switch pass {
        case .standard: .pass1
        case .giant: .pass2
        case .ant: .pass3
        case .testWalk: .testWalk
        }
    }

    /// Do and don't cards: a short heading, and the SCANNING.md sentence it comes from.
    struct Card: Identifiable {
        let isDo: Bool
        let heading: String
        let source: String
        var id: String { heading }
    }

    static let cards: [Card] = [
        Card(isDo: true, heading: "Even daylight", source: "daytime, curtains open"),
        Card(isDo: false, heading: "Sun patches", source: "no harsh sun patches"),
        Card(isDo: true, heading: "Cupboards shut", source: "Close cupboard doors, and tidy cables and things on the walls."),
        Card(isDo: false, heading: "Starting at the window", source: "start facing a typical part of the room, not the window."),
        Card(isDo: true, heading: "Hold still to lock", source: "Hold the phone steady until the lock icon shows"),
        Card(isDo: false, heading: "Rushing", source: #"A red "slow down" means frames will blur."#),
        Card(isDo: true, heading: "An empty room", source: "Keep people and pets out of the room."),
        Card(isDo: false, heading: "Spinning on the spot", source: "never spin on the spot"),
    ]
}

/// The first-run guide: shown once, on the first launch, then only from How to scan.
enum OnboardingState {
    /// Versioned: a new way of scanning shows the guide again, once.
    static let key = "onboardingSeen-0.5"

    static func needsFirstRun(_ defaults: UserDefaults = .standard) -> Bool {
        !defaults.bool(forKey: key)
    }

    static func markSeen(_ defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: key)
    }

    /// Unit tests host the app: no sheet over them.
    static var isRunningTests: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    }
}
