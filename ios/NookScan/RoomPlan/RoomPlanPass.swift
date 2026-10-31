import ARKit
import Foundation
import RoomPlan
import simd

/// What the scan leave for lining up the RoomPlan pass (contract §4.12): the floor, the vertical planes and
/// the phone's last pose, all in capture world.
struct CaptureAnchors {
    var floorY: Float?
    var walls: [WallPlane]
    var endPose: simd_float4x4?
}

/// The RoomPlan setting (on by default) and whether this phone can run it at all.
enum RoomPlanSettings {
    static let key = "roomPlanEnabled"

    /// RoomPlan needs LiDAR. False in the simulator.
    static var isSupported: Bool { RoomCaptureSession.isSupported }

    static var isEnabled: Bool {
        UserDefaults.standard.object(forKey: key) as? Bool ?? true
    }
}

/// The separate RoomPlan pass after the scan (v4 decision 0b): RoomPlan runs its own ARSession, so it can't
/// disturb the capture's (video format, depth, exposure lock, keyframes, stills). When it ends, the room is built,
/// lined up with the capture (ShellAlignment) and written next to it (RoomPlanWriter). If anything fails, or the pass
/// is skipped, the capture stays a valid v1.2 capture.
final class RoomPlanPass: NSObject, ObservableObject, Identifiable, RoomCaptureSessionDelegate {
    enum Phase: Equatable {
        case scanning
        case building
        case saved(walls: Int, matched: Int)
        case failed(String)
        case skipped

        var isActive: Bool { self == .scanning || self == .building }
    }

    /// RoomPlan usually has the room after about a minute; it stops by itself after `maxSeconds`.
    static let targetSeconds = 60.0
    static let maxSeconds = 90.0

    @Published private(set) var phase = Phase.scanning
    /// RoomPlan's coaching, in plain words, or nil when all is well.
    @Published private(set) var instruction: String?
    @Published private(set) var wallCount = 0
    @Published private(set) var elapsed = 0.0

    let session = RoomCaptureSession()
    let folder: URL
    let anchors: CaptureAnchors
    private var startPose: simd_float4x4?
    private var started: Date?
    private var timer: Timer?
    private var stopping = false

    init(folder: URL, anchors: CaptureAnchors) {
        self.folder = folder
        self.anchors = anchors
        super.init()
        session.delegate = self
    }

    var arSession: ARSession { session.arSession }

    func start() {
        guard started == nil else { return }
        started = Date()
        var config = RoomCaptureSession.Configuration()
        config.isCoachingEnabled = true
        session.run(configuration: config)
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
    }

    /// Ends the pass and saves the shell.
    func finish() {
        guard phase == .scanning, !stopping else { return }
        stopping = true
        timer?.invalidate()
        phase = .building
        session.stop()
    }

    /// Ends the pass without writing anything.
    func skip() {
        guard phase == .scanning else { return }
        timer?.invalidate()
        phase = .skipped
        session.stop()
    }

    private func tick() {
        guard phase == .scanning, let started else { return }
        elapsed = Date().timeIntervalSince(started)
        recordStartPose()
        if elapsed >= Self.maxSeconds { finish() }
    }

    /// RoomPlan's first well-tracked camera pose: with the capture's last pose, the prior for the alignment.
    private func recordStartPose() {
        guard startPose == nil, let frame = session.arSession.currentFrame, frame.camera.trackingState == .normal else { return }
        startPose = frame.camera.transform
    }

    static func text(for instruction: RoomCaptureSession.Instruction) -> String? {
        switch instruction {
        case .normal: nil
        case .moveCloseToWall: "Move closer to the wall"
        case .moveAwayFromWall: "Step back from the wall"
        case .slowDown: "Slow down"
        case .turnOnLight: "Too dark: turn on a light"
        case .lowTexture: "Not enough detail here: point at another part of the room"
        @unknown default: nil
        }
    }

    // MARK: RoomCaptureSessionDelegate

    func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
        let n = room.walls.count
        DispatchQueue.main.async {
            self.recordStartPose()
            if self.wallCount != n { self.wallCount = n }
        }
    }

    func captureSession(_ session: RoomCaptureSession, didProvide instruction: RoomCaptureSession.Instruction) {
        let text = Self.text(for: instruction)
        DispatchQueue.main.async { if self.instruction != text { self.instruction = text } }
    }

    func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
        DispatchQueue.main.async {
            guard self.phase == .building || self.phase == .scanning else { return }   // skipped
            self.timer?.invalidate()
            if let error {
                self.phase = .failed("RoomPlan stopped: \(error.localizedDescription)")
                return
            }
            self.phase = .building
            let folder = self.folder, anchors = self.anchors
            let prior = anchors.endPose.flatMap { end in
                self.startPose.map { ShellAlignment.prior(captureEnd: end, roomplanStart: $0) }
            }
            Task.detached(priority: .userInitiated) {
                let result: Phase
                do {
                    let room = try await RoomBuilder(options: [.beautifyObjects]).capturedRoom(from: data)
                    result = try Self.save(room, anchors: anchors, prior: prior, into: folder)
                } catch {
                    result = .failed(error.localizedDescription)
                }
                await MainActor.run { if self.phase == .building { self.phase = result } }
            }
        }
    }

    /// Lines the room up with the capture and writes roomplan.json, roomplan.usdz and meta.roomplan.
    private static func save(_ room: CapturedRoom, anchors: CaptureAnchors, prior: simd_float4x4?, into folder: URL) throws -> Phase {
        let (shell, solution) = try ShellAligner.align(shell(from: room), anchors: anchors, prior: prior)
        let usdz = FileManager.default.temporaryDirectory.appendingPathComponent("roomplan-\(UUID().uuidString).usdz")
        defer { try? FileManager.default.removeItem(at: usdz) }
        let exported = (try? room.export(to: usdz, exportOptions: .mesh)) != nil
        try RoomPlanWriter.write(shell, sessions: .separate, usdz: exported ? usdz : nil, into: folder)
        return .saved(walls: shell.walls.count, matched: solution.matchedWalls)
    }

    // MARK: CapturedRoom → roomplan.json

    static func shell(from room: CapturedRoom) -> RoomShell {
        func surface(_ s: CapturedRoom.Surface, parent: Bool) -> RoomShell.Surface {
            RoomShell.Surface(id: s.identifier.uuidString.lowercased(), dimensions: dims(s.dimensions),
                              transform: RoomShell.rows(rigid(s.transform)), confidence: confidence(s.confidence),
                              parent: parent ? s.parentIdentifier?.uuidString.lowercased() : nil)
        }
        let objects = room.objects.map { o in
            RoomShell.Surface(id: o.identifier.uuidString.lowercased(), dimensions: dims(o.dimensions),
                              transform: RoomShell.rows(rigid(o.transform)), confidence: confidence(o.confidence),
                              category: String(describing: o.category))
        }
        return RoomShell(walls: room.walls.map { surface($0, parent: false) },
                         floors: room.floors.map { surface($0, parent: false) },
                         doors: room.doors.map { surface($0, parent: true) },
                         windows: room.windows.map { surface($0, parent: true) },
                         openings: room.openings.map { surface($0, parent: true) },
                         objects: objects)
    }

    private static func dims(_ d: simd_float3) -> [Double] {
        [d.x, d.y, d.z].map { CaptureWriter.decimal(Double(max(0, $0)), 4) }
    }

    private static func confidence(_ c: CapturedRoom.Confidence) -> String {
        switch c {
        case .high: "high"
        case .medium: "medium"
        case .low: "low"
        @unknown default: "low"
        }
    }

    /// The transform with its rotation re-orthonormalized (Gram–Schmidt on X and Y), so float noise in RoomPlan's
    /// matrices never fails the §4.5 rigidity check.
    static func rigid(_ m: simd_float4x4) -> simd_float4x4 {
        let x = simd_normalize(m[0].xyz)
        let y = simd_normalize(m[1].xyz - simd_dot(m[1].xyz, x) * x)
        let z = simd_cross(x, y)
        return simd_float4x4(columns: (SIMD4(x, 0), SIMD4(y, 0), SIMD4(z, 0), SIMD4(m[3].xyz, 1)))
    }
}

/// Puts `world_from_roomplan` on a shell in its own RoomPlan frame. Kept apart from RoomPlan so tests can run it.
enum ShellAligner {
    static func align(_ shell: RoomShell, anchors: CaptureAnchors, prior: simd_float4x4?) throws -> (RoomShell, ShellAlignment.Solution) {
        let solution = try ShellAlignment.solve(roomplanWalls: shell.wallPlanes, roomplanFloorY: shell.floorY,
                                                captureWalls: anchors.walls, captureFloorY: anchors.floorY, prior: prior)
        var out = shell
        out.worldFromRoomplan = RoomShell.rows(solution.worldFromRoomplan)
        return (out, solution)
    }
}
