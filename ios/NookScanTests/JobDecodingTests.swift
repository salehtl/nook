import Foundation
import Testing
@testable import NookScan

/// The job object and friends from contract §5, as the server (and evals/mock_scan_server.py) send them.
struct JobDecodingTests {
    let decoder = ServerJSON.decoder()

    private func job(_ json: String) throws -> ScanJob {
        try decoder.decode(ScanJob.self, from: Data(json.utf8))
    }

    /// The contract's example, with every nullable field null.
    static let queuedJSON = """
    {
      "id": "j-20261026-101500-ab12",
      "capture": "scan-20261026-093654",
      "name": "scan-20261026-093654",
      "status": "queued",
      "stage": "waiting",
      "progress": 0.0,
      "step": 0, "total_steps": 30000,
      "eta_s": null,
      "created": "2026-10-26T10:15:00Z", "started": null, "finished": null,
      "message": "waiting for the GPU",
      "result": null
    }
    """

    @Test func contractExampleWithNulls() throws {
        let j = try job(Self.queuedJSON)
        #expect(j.id == "j-20261026-101500-ab12")
        #expect(j.capture == "scan-20261026-093654")
        #expect(j.name == "scan-20261026-093654")
        #expect(j.status == .queued)
        #expect(j.stage == "waiting")
        #expect(j.progress == 0)
        #expect(j.step == 0)
        #expect(j.totalSteps == 30000)
        #expect(j.etaS == nil)
        #expect(j.created == "2026-10-26T10:15:00Z")
        #expect(j.started == nil)
        #expect(j.finished == nil)
        #expect(j.message == "waiting for the GPU")
        #expect(j.result == nil)
        #expect(!j.status.isFinished)
        #expect(j.timeLeft == nil)
    }

    @Test func everyStatusDecodes() throws {
        #expect(JobStatus.allCases.map(\.rawValue) == ["queued", "training", "done", "failed", "cancelled"])
        for status in JobStatus.allCases {
            let j = try job(Self.queuedJSON.replacingOccurrences(of: "\"queued\"", with: "\"\(status.rawValue)\""))
            #expect(j.status == status)
            #expect(j.status.isFinished == (status == .done || status == .failed || status == .cancelled))
        }
    }

    @Test func everyStageDecodesAsText() throws {
        for stage in ["waiting", "preparing", "building trainer", "training", "finishing", "done"] {
            #expect(try job(Self.queuedJSON.replacingOccurrences(of: "\"waiting\"", with: "\"\(stage)\"")).stage == stage)
        }
    }

    @Test func unknownStatusIsRejected() {
        #expect(throws: DecodingError.self) {
            try job(Self.queuedJSON.replacingOccurrences(of: "\"queued\"", with: "\"uploading\""))
        }
    }

    /// Exactly what the mock writes while training (Python's json.dumps spacing, float eta).
    @Test func trainingJobFromTheMock() throws {
        let j = try job("""
        {"id": "j-20261026-101500-ab12", "capture": "scan-20261026-093654", "name": "scan-20261026-093654", \
        "status": "training", "stage": "training", "progress": 0.421, "step": 12630, "total_steps": 30000, \
        "eta_s": 2.3, "created": "2026-10-26T10:15:00Z", "started": "2026-10-26T10:15:01Z", "finished": null, \
        "message": "training: step 12630/30000", "result": null}
        """)
        #expect(j.status == .training)
        #expect(j.progress == 0.421)
        #expect(j.step == 12630)
        #expect(j.etaS == 2.3)
        #expect(j.started == "2026-10-26T10:15:01Z")
        #expect(j.shortStatus == "Training · 42%")
        #expect(j.timeLeft == "Less than a minute left")
    }

    @Test func doneJobCarriesTheResult() throws {
        let j = try job("""
        {"id": "j-1", "capture": "scan-20261026-093654", "name": "scan-20261026-093654", "status": "done", \
        "stage": "done", "progress": 1.0, "step": 30000, "total_steps": 30000, "eta_s": 0, \
        "created": "2026-10-26T10:15:00Z", "started": "2026-10-26T10:15:01Z", "finished": "2026-10-26T10:45:00Z", \
        "message": "room ready", "result": {"name": "scan-20261026-093654", "ply": "room/scan-20261026-093654.ply", \
        "room_json": "room/room.json", "splats": 123456, "floor_y": -1.35, "steps": 30000, "seconds": 1799.5, \
        "trainer": "brush 0.3.0", "psnr": null, "room_url": "/planner/", "ply_url": "/room/scan-20261026-093654.ply"}}
        """)
        #expect(j.status == .done)
        #expect(j.etaS == 0, "an integer eta decodes as a number")
        #expect(j.finished == "2026-10-26T10:45:00Z")
        let r = try #require(j.result)
        #expect(r.roomUrl == "/planner/")
        #expect(r.plyUrl == "/room/scan-20261026-093654.ply")
        #expect(r.roomJson == "room/room.json")
        #expect(r.splats == 123456)
        #expect(r.floorY == -1.35)
        #expect(r.seconds == 1799.5)
        #expect(r.trainer == "brush 0.3.0")
        #expect(r.psnr == nil)
        #expect(j.shortStatus == "Room ready")
        #expect(j.timeLeft == nil)
    }

    @Test func resultNeedsOnlyTheRoomURL() throws {
        let json = Self.queuedJSON
            .replacingOccurrences(of: "\"result\": null", with: "\"result\": {\"room_url\": \"/planner/\", \"floor_y\": null}")
        let r = try #require(try job(json).result)
        #expect(r.roomUrl == "/planner/")
        #expect(r.floorY == nil)
        #expect(r.splats == nil)
    }

    @Test func timeLeftWording() throws {
        func eta(_ s: String) throws -> String? {
            try job(Self.queuedJSON.replacingOccurrences(of: "\"eta_s\": null", with: "\"eta_s\": \(s)")).timeLeft
        }
        #expect(try eta("30") == "Less than a minute left")
        #expect(try eta("241") == "About 5 min left")
        #expect(try eta("7200") == "About 2 h left")
        #expect(try eta("0") == nil)
    }

    @Test func healthDecodes() throws {
        let h = try decoder.decode(ServerHealth.self, from: Data("""
        {"ok": true, "version": "0.2.0", "trainer": "brush 0.3.0", "gpu": null, "busy": false, "queued": 0}
        """.utf8))
        #expect(h == ServerHealth(ok: true, version: "0.2.0", trainer: "brush 0.3.0", gpu: nil, busy: false, queued: 0))
        let mock = try decoder.decode(ServerHealth.self, from: Data("""
        {"ok": true, "version": "mock", "trainer": "mock", "gpu": "Mock GPU", "busy": true, "queued": 2}
        """.utf8))
        #expect(mock.gpu == "Mock GPU")
        #expect(mock.busy)
        #expect(mock.queued == 2)
    }

    @Test func errorBodyDecodes() throws {
        let e = try decoder.decode(ServerErrorBody.self, from: Data(#"{"error": "capture is larger than 4 GB"}"#.utf8))
        #expect(e.error == "capture is larger than 4 GB")
    }

    @Test func jobRoundTripsThroughTheRecordFile() throws {
        let j = try job(Self.queuedJSON)
        let data = try ServerJSON.encoder().encode(j)
        #expect(try decoder.decode(ScanJob.self, from: data) == j)
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.contains("\"total_steps\":30000"), "snake_case on disk, like the API")
    }
}
