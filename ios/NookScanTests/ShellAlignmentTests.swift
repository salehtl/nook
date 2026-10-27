import simd
import XCTest
@testable import NookScan

/// The RoomPlan alignment (contract §4.12, `world_from_roomplan`) on synthetic planes with a known answer, and the
/// v1.3 writer.
final class ShellAlignmentTests: XCTestCase {
    static let deg = Double.pi / 180

    /// Deterministic noise in [−1, 1].
    fileprivate struct Noise {
        var state: UInt64 = 0x9E37_79B9_7F4A_7C15
        mutating func next() -> Double {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Double(state >> 11) / Double(1 << 52) * 2 - 1
        }
    }

    /// An L-shaped room in a RoomPlan frame: six walls (width along local X, normal local Z), floor at −1.4.
    static func lRoom() -> [WallPlane] {
        // Corners of an L, counter-clockwise: 5 × 4 m with a 2 × 1.5 m notch.
        let pts: [SIMD2<Float>] = [[-2.5, -2], [2.5, -2], [2.5, 0.5], [0.5, 0.5], [0.5, 2], [-2.5, 2]]
        return (0..<pts.count).map { i in
            let a = pts[i], b = pts[(i + 1) % pts.count]
            let mid = (a + b) / 2, dir = simd_normalize(b - a)
            return WallPlane(center: SIMD3(mid.x, -0.05, mid.y), normal: SIMD3(-dir.y, 0, dir.x), width: simd_length(b - a))
        }
    }

    static func rect(w: Float, d: Float) -> [WallPlane] {
        [WallPlane(center: [0, 0, -d / 2], normal: [0, 0, 1], width: w),
         WallPlane(center: [0, 0, d / 2], normal: [0, 0, -1], width: w),
         WallPlane(center: [w / 2, 0, 0], normal: [-1, 0, 0], width: d),
         WallPlane(center: [-w / 2, 0, 0], normal: [1, 0, 0], width: d)]
    }

    static func apply(_ m: simd_float4x4, _ p: WallPlane) -> WallPlane {
        let c = m * SIMD4(p.center, 1), n = m * SIMD4(p.normal, 0)
        return WallPlane(center: c.xyz, normal: n.xyz, width: p.width)
    }

    /// What ARKit would see of `walls` in capture world: each wall as two partial planes along it, with millimeter
    /// noise along the normal and a tenth of a degree of tilt, the normals' signs scrambled.
    fileprivate static func captured(_ walls: [WallPlane], by m: simd_float4x4, noise: inout Noise) -> [WallPlane] {
        walls.flatMap { wall -> [WallPlane] in
            let w = apply(m, wall)
            let t = SIMD3<Float>(w.normal.z, 0, -w.normal.x)
            return [-1, 1].map { (side: Float) -> WallPlane in
                let turn = Float(noise.next() * 0.1 * deg)
                let n = simd_quatf(angle: turn, axis: [0, 1, 0]).act(w.normal) * (noise.next() > 0 ? 1 : -1)
                let c = w.center + t * (side * w.width / 4) + w.normal * Float(noise.next() * 0.002)
                return WallPlane(center: c + SIMD3(0, Float(noise.next() * 0.3), 0), normal: n, width: w.width * 0.4)
            }
        }
    }

    private func assertSolution(_ s: ShellAlignment.Solution, yaw: Double, shift: SIMD3<Double>,
                                file: StaticString = #filePath, line: UInt = #line) {
        let dyaw = abs(ShellAlignment.wrapPi(s.yaw - yaw)) / Self.deg
        XCTAssertLessThan(dyaw, 0.5, "yaw off by \(dyaw)°", file: file, line: line)
        let dt = simd_length(s.offset - shift)
        XCTAssertLessThan(dt, 0.01, "offset off by \(dt * 100) cm: \(s.offset) vs \(shift)", file: file, line: line)
    }

    func testRecoversKnownYawAndOffset() throws {
        let yaw = 37.3 * Self.deg, shift = SIMD3<Double>(0.83, -0.21, -1.37)
        let truth = ShellAlignment.matrix(yaw: yaw, shift: shift)
        let rp = Self.lRoom()
        var noise = Noise()
        var cap = Self.captured(Array(rp.dropLast()), by: truth, noise: &noise)    // one wall never seen
        // Not walls: a wardrobe front 60 cm in front of a wall, and a picture frame at an odd angle.
        let wardrobe = Self.apply(truth, WallPlane(center: [0, 0, -1.4], normal: [0, 0, 1], width: 1.6))
        cap.append(wardrobe)
        cap.append(Self.apply(truth, WallPlane(center: [1, 0, 0], normal: [sin(0.4), 0, cos(0.4)], width: 0.8)))
        let rpFloor: Float = -1.4
        let prior = ShellAlignment.matrix(yaw: yaw + 12 * Self.deg, shift: shift + SIMD3(0.4, 0.1, -0.3))
        let s = try ShellAlignment.solve(roomplanWalls: rp, roomplanFloorY: rpFloor, captureWalls: cap,
                                         captureFloorY: rpFloor + Float(shift.y), prior: prior)
        assertSolution(s, yaw: yaw, shift: shift)
        XCTAssertEqual(s.matchedWalls, 5)
        XCTAssertLessThan(s.residual, 0.005)

        // And without a prior: an L-shaped room has only one fit.
        let s2 = try ShellAlignment.solve(roomplanWalls: rp, roomplanFloorY: rpFloor, captureWalls: cap,
                                          captureFloorY: rpFloor + Float(shift.y))
        assertSolution(s2, yaw: yaw, shift: shift)
    }

    func testRecoversEveryQuadrant() throws {
        for yawDeg in [-170.0, -95.5, -12.25, 0, 44.9, 90, 133.7] {
            let yaw = yawDeg * Self.deg, shift = SIMD3<Double>(-1.2, 0.4, 2.05)
            let truth = ShellAlignment.matrix(yaw: yaw, shift: shift)
            var noise = Noise()
            let rp = Self.lRoom()
            let cap = Self.captured(rp, by: truth, noise: &noise)
            let s = try ShellAlignment.solve(roomplanWalls: rp, roomplanFloorY: 0, captureWalls: cap, captureFloorY: 0.4)
            assertSolution(s, yaw: yaw, shift: shift)
        }
    }

    func testPriorResolvesAHalfTurnInARectangularRoom() throws {
        // A 3.5 × 4 m box fits itself turned 180°: only the phone's pose between the passes tells them apart.
        let yaw = 200 * Self.deg, shift = SIMD3<Double>(0.6, -0.3, 1.1)
        let truth = ShellAlignment.matrix(yaw: yaw, shift: shift)
        var noise = Noise()
        let rp = Self.rect(w: 3.5, d: 4)
        let cap = Self.captured(rp, by: truth, noise: &noise)
        for priorError in [-25.0, 25.0] {
            let prior = ShellAlignment.matrix(yaw: yaw + priorError * Self.deg, shift: shift + SIMD3(-0.5, 0, 0.4))
            let s = try ShellAlignment.solve(roomplanWalls: rp, roomplanFloorY: -1, captureWalls: cap, captureFloorY: -1.3, prior: prior)
            assertSolution(s, yaw: yaw, shift: shift)
        }
    }

    func testRefusesWallsInOneDirectionOnly() {
        let rp = [WallPlane(center: [0, 0, -2], normal: [0, 0, 1], width: 4), WallPlane(center: [0, 0, 2], normal: [0, 0, -1], width: 4)]
        XCTAssertThrowsError(try ShellAlignment.solve(roomplanWalls: rp, roomplanFloorY: 0, captureWalls: rp, captureFloorY: 0)) {
            XCTAssertEqual($0 as? ShellAlignment.Failure, .oneDirection)
        }
        XCTAssertThrowsError(try ShellAlignment.solve(roomplanWalls: Self.rect(w: 3, d: 4), roomplanFloorY: 0, captureWalls: [], captureFloorY: 0)) {
            XCTAssertEqual($0 as? ShellAlignment.Failure, .noWalls)
        }
    }

    func testPriorFromPosesUndoesTheSessionChange() {
        let truth = ShellAlignment.matrix(yaw: -63 * Self.deg, shift: [1.5, 0.2, -0.7])
        // The phone at the start of RoomPlan: tilted down 30°, turned 10°, somewhere in RoomPlan's frame.
        let tilt = simd_float4x4(simd_quatf(angle: 10 * .pi / 180, axis: [0, 1, 0]) * simd_quatf(angle: -30 * .pi / 180, axis: [1, 0, 0]))
        var start = tilt
        start.columns.3 = [0.1, 0.05, -0.2, 1]
        let end = truth * start   // same physical pose, in capture world
        let prior = ShellAlignment.prior(captureEnd: end, roomplanStart: start)
        XCTAssertEqual(ShellAlignment.yaw(of: prior), -63 * Self.deg, accuracy: 1e-4)
        for c in 0..<4 { for r in 0..<4 { XCTAssertEqual(prior[c][r], truth[c][r], accuracy: 1e-4) } }
    }

    /// The hand-made fixtures are the same room in two frames: aligning one to the other recovers the fixture's
    /// world_from_roomplan.
    func testFixtureRoomLinesUpWithItsSharedTwin() throws {
        let separate = try Self.fixtureShell("roomplan-separate")
        let shared = try Self.fixtureShell("roomplan")
        let truth = try XCTUnwrap(separate.worldFromRoomplan.flatMap(RoomShell.matrix))
        var noise = Noise()
        // Capture planes: the shared walls (already in capture world), cut up and noised as ARKit would see them.
        let cap = Self.captured(shared.wallPlanes, by: matrix_identity_float4x4, noise: &noise)
        let prior = ShellAlignment.matrix(yaw: ShellAlignment.yaw(of: truth) - 20 * Self.deg, shift: [0.8, 0, 0.6])
        var stripped = separate
        stripped.worldFromRoomplan = nil
        let (aligned, s) = try ShellAligner.align(stripped, anchors: CaptureAnchors(floorY: shared.floorY, walls: cap, endPose: nil), prior: prior)
        assertSolution(s, yaw: ShellAlignment.yaw(of: truth),
                       shift: SIMD3(Double(truth.columns.3.x), Double(truth.columns.3.y), Double(truth.columns.3.z)))
        let m = try XCTUnwrap(aligned.worldFromRoomplan)
        let t = try XCTUnwrap(separate.worldFromRoomplan)
        for r in 0..<4 { for c in 0..<4 { XCTAssertEqual(m[r][c], t[r][c], accuracy: 0.01) } }
    }

    func testWriterChecksTheFrameAndLeavesMetaAloneOnError() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rp-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let meta = Data(#"{"version": 1, "frame_count": 40}"#.utf8)
        try meta.write(to: dir.appendingPathComponent("meta.json"))
        var shell = try Self.fixtureShell("roomplan-separate")
        XCTAssertThrowsError(try RoomPlanWriter.write(shell, sessions: .shared, into: dir))
        shell.worldFromRoomplan = nil
        XCTAssertThrowsError(try RoomPlanWriter.write(shell, sessions: .separate, into: dir))
        XCTAssertEqual(try Data(contentsOf: dir.appendingPathComponent("meta.json")), meta)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("roomplan.json").path))

        try RoomPlanWriter.write(shell, sessions: .shared, version: "iOS 18.0", into: dir)
        let m = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("meta.json"))) as? [String: Any])
        XCTAssertEqual(m["roomplan"] as? [String: String], ["version": "iOS 18.0", "sessions": "shared"])
        XCTAssertEqual(m["frame_count"] as? Int, 40)
    }

    func testRigidCleansUpFloatNoise() {
        var m = ShellAlignment.matrix(yaw: 0.7, shift: [1, 2, 3])
        m[0] += SIMD4(0.002, -0.001, 0.0015, 0)
        let r = RoomPlanPass.rigid(m)
        let rot = simd_float3x3(r[0].xyz, r[1].xyz, r[2].xyz)
        XCTAssertEqual(rot.determinant, 1, accuracy: 1e-5)
        let rtr = rot.transpose * rot
        for a in 0..<3 { for b in 0..<3 { XCTAssertEqual(rtr[a][b], a == b ? 1 : 0, accuracy: 1e-5) } }
        XCTAssertEqual(r[3], SIMD4(1, 2, 3, 1))
    }

    static func fixtureShell(_ name: String) throws -> RoomShell {
        let url = try XCTUnwrap(Bundle(for: ShellAlignmentTests.self).url(forResource: name, withExtension: "json", subdirectory: "roomplan"))
        return try JSONDecoder().decode(RoomShell.self, from: Data(contentsOf: url))
    }
}
