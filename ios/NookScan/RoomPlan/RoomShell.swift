import Foundation
import simd

/// A measured room shell in the `roomplan.json` shape (contract §4.12, roomplan.schema.json): every surface's
/// transform maps its local frame (centered, width along local X, height along local Y) to the RoomPlan session's
/// world. Built from a CapturedRoom on the phone, or decoded from a file (the replay test, fixtures/roomplan/).
struct RoomShell: Codable, Equatable {
    struct Surface: Codable, Equatable {
        var id: String
        /// Width, height, depth in meters.
        var dimensions: [Double]
        /// 4 × 4, row-major.
        var transform: [[Double]]
        var confidence: String?
        /// Doors, windows and openings: the wall they sit in.
        var parent: String?
        /// Objects: RoomPlan's category name.
        var category: String?
    }

    var version = 1
    var walls: [Surface]
    var floors: [Surface]
    var doors: [Surface] = []
    var windows: [Surface] = []
    var openings: [Surface] = []
    var objects: [Surface] = []
    /// Capture world from RoomPlan world (4 × 4, row-major). Required when the sessions are separate.
    var worldFromRoomplan: [[Double]]?

    enum CodingKeys: String, CodingKey {
        case version, walls, floors, doors, windows, openings, objects
        case worldFromRoomplan = "world_from_roomplan"
    }

    init(walls: [Surface], floors: [Surface], doors: [Surface] = [], windows: [Surface] = [],
         openings: [Surface] = [], objects: [Surface] = [], worldFromRoomplan: [[Double]]? = nil) {
        self.walls = walls
        self.floors = floors
        self.doors = doors
        self.windows = windows
        self.openings = openings
        self.objects = objects
        self.worldFromRoomplan = worldFromRoomplan
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        walls = try c.decode([Surface].self, forKey: .walls)
        floors = try c.decode([Surface].self, forKey: .floors)
        doors = try c.decodeIfPresent([Surface].self, forKey: .doors) ?? []
        windows = try c.decodeIfPresent([Surface].self, forKey: .windows) ?? []
        openings = try c.decodeIfPresent([Surface].self, forKey: .openings) ?? []
        objects = try c.decodeIfPresent([Surface].self, forKey: .objects) ?? []
        worldFromRoomplan = try c.decodeIfPresent([[Double]].self, forKey: .worldFromRoomplan)
    }

    // MARK: Geometry for the alignment (ShellAlignment)

    /// Every wall as a vertical plane in the RoomPlan frame: its center, its normal (local Z), its width.
    var wallPlanes: [WallPlane] {
        walls.compactMap { s in
            guard let m = Self.matrix(s.transform) else { return nil }
            return WallPlane(transform: m, width: Float(s.dimensions.first ?? 0), normalColumn: 2)
        }
    }

    /// Height of the floor in the RoomPlan frame: the center of the largest floor surface.
    var floorY: Float? {
        floors.max { area($0) < area($1) }.flatMap { Self.matrix($0.transform) }.map { $0.columns.3.y }
    }

    private func area(_ s: Surface) -> Double {
        s.dimensions.count >= 2 ? s.dimensions[0] * s.dimensions[1] : 0
    }

    /// A row-major 4 × 4 as a simd matrix, or nil if it isn't 4 × 4.
    static func matrix(_ rows: [[Double]]) -> simd_float4x4? {
        guard rows.count == 4, rows.allSatisfy({ $0.count == 4 }) else { return nil }
        var m = simd_float4x4()
        for r in 0..<4 { for c in 0..<4 { m[c][r] = Float(rows[r][c]) } }
        return m
    }

    /// Row-major nested arrays, rounded to 6 decimals (micrometers; rotations stay orthonormal well within 1e-3).
    static func rows(_ m: simd_float4x4) -> [[Double]] {
        (0..<4).map { r in (0..<4).map { c in CaptureWriter.decimal(Double(m[c][r]), 6) } }
    }
}

/// Writes a capture's v1.3 files (contract §4.12): `roomplan.json`, `roomplan.usdz` when there is one, then
/// `meta.roomplan` in the already written `meta.json`. roomplan.json goes first, so `meta.roomplan` is never set
/// without its file. If anything fails the capture is left as it was (a valid v1.2 capture).
enum RoomPlanWriter {
    enum Sessions: String { case shared, separate }

    /// "iOS 18.2": RoomPlan ships with iOS, so its version is the OS version.
    static var version: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "iOS \(v.majorVersion).\(v.minorVersion)" + (v.patchVersion > 0 ? ".\(v.patchVersion)" : "")
    }

    static func write(_ shell: RoomShell, sessions: Sessions, usdz: URL? = nil, version: String = RoomPlanWriter.version,
                      into folder: URL) throws {
        let fm = FileManager.default
        let jsonURL = folder.appendingPathComponent("roomplan.json")
        let usdzURL = folder.appendingPathComponent("roomplan.usdz")
        let metaURL = folder.appendingPathComponent("meta.json")
        switch sessions {
        case .separate where shell.worldFromRoomplan == nil:
            throw CaptureError.write("a separate RoomPlan session needs world_from_roomplan")
        case .shared where shell.worldFromRoomplan != nil:
            throw CaptureError.write("a shared RoomPlan session has no world_from_roomplan")
        default: break
        }
        guard !shell.walls.isEmpty, !shell.floors.isEmpty else {
            throw CaptureError.write("the room shell needs at least one wall and one floor")
        }
        guard var meta = try JSONSerialization.jsonObject(with: Data(contentsOf: metaURL)) as? [String: Any] else {
            throw CaptureError.write("meta.json is not a JSON object")
        }
        do {
            let enc = JSONEncoder()
            enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            try enc.encode(shell).write(to: jsonURL, options: .atomic)
            if let usdz {
                try? fm.removeItem(at: usdzURL)
                try fm.copyItem(at: usdz, to: usdzURL)
            }
            meta["roomplan"] = ["version": version, "sessions": sessions.rawValue]
            let data = try JSONSerialization.data(withJSONObject: meta, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: metaURL, options: .atomic)
        } catch {
            try? fm.removeItem(at: jsonURL)
            try? fm.removeItem(at: usdzURL)
            throw CaptureError.write(error.localizedDescription)
        }
    }
}
