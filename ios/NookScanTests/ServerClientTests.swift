import Foundation
import Testing
@testable import NookScan

/// The processing-server client (contract §5). The integration tests need a server: evals/ios_build.sh starts
/// evals/mock_scan_server.py and passes its URL as NOOK_SERVER_URL (TEST_RUNNER_NOOK_SERVER_URL to xcodebuild).
struct ServerClientTests {
    static let serverURL = ProcessInfo.processInfo.environment["NOOK_SERVER_URL"].flatMap(ServerSettings.normalized)
    /// How long a job may take to finish: seconds against the mock, longer against a real trainer.
    static let jobTimeout = ProcessInfo.processInfo.environment["NOOK_SERVER_TIMEOUT"].flatMap(Double.init) ?? 600

    // MARK: Integration (needs a server)

    /// Zips the replay capture, uploads it with the app's background uploader, polls the job to done, and checks
    /// the room URL.
    @Test(.enabled(if: ServerClientTests.serverURL != nil, "set NOOK_SERVER_URL (evals/ios_build.sh starts the mock)"),
          .timeLimit(.minutes(15)))
    @MainActor
    func testUploadAndPollAgainstServer() async throws {
        let server = try #require(Self.serverURL)
        let client = ServerClient(base: server)
        let health = try await client.health()
        #expect(health.ok)

        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("server-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let folder = try Self.replayCapture(in: tmp.appendingPathComponent("captures", isDirectory: true))
        let capture = folder.lastPathComponent

        let uploader = Uploader(identifier: "com.salehtl.nookscan.tests.\(UUID().uuidString)",
                                zipFolder: tmp.appendingPathComponent("uploads", isDirectory: true))
        defer { uploader.invalidate() }
        let zip = try CaptureStore.makeZip(of: folder, into: uploader.zipFolder)
        #expect(zip == uploader.zipURL(for: capture))

        let (result, fractions) = await Self.upload(capture, with: uploader, to: server)
        let job = try result.get()
        #expect(job.capture == capture)
        #expect(job.name == capture, "the room is named after the capture folder by default")
        #expect([JobStatus.queued, .training, .done].contains(job.status))
        #expect(fractions.last == 1, "upload progress reaches 100% (got \(fractions.count) updates)")
        #expect(fractions.allSatisfy { (0...1).contains($0) })
        #expect(fractions == fractions.sorted(), "upload progress only goes up")
        #expect(!FileManager.default.fileExists(atPath: zip.path), "the staged zip is deleted once uploaded")

        var current = job
        var last = 0.0
        let deadline = Date().addingTimeInterval(Self.jobTimeout)
        while !current.status.isFinished {
            try #require(Date() < deadline, "job \(job.id) didn't finish in \(Int(Self.jobTimeout)) s: \(current.message)")
            try await Task.sleep(for: .milliseconds(500))
            current = try await client.job(job.id)
            #expect(current.id == job.id)
            #expect((0...1).contains(current.progress))
            if current.status == .training {
                #expect(current.progress >= last, "progress only goes up while training")
                last = current.progress
            }
        }
        #expect(current.status == .done, "\(current.message)")
        let room = try #require(current.result)
        // Contract §5: room_url is "/planner/?room=<name>" (§2.7), a site path on the server's own origin.
        #expect(room.roomUrl == "/planner/?room=\(current.name)")
        #expect(client.siteURL(try #require(room.roomUrl))?.absoluteString == server.absoluteString + "/planner/?room=\(current.name)")

        // Same capture again: idempotent, the existing job comes back.
        _ = try CaptureStore.makeZip(of: folder, into: uploader.zipFolder)
        let again = try await Self.upload(capture, with: uploader, to: server).0.get()
        #expect(again.id == job.id)
    }

    /// The app's own flow: health check, zip, background upload, job ID stored per capture, polling to done.
    @Test(.enabled(if: ServerClientTests.serverURL != nil, "set NOOK_SERVER_URL"), .timeLimit(.minutes(15)))
    @MainActor
    func processingStoreSendsAndFollowsTheJob() async throws {
        let server = try #require(Self.serverURL)
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("store-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        // A different folder name from the other integration test, which runs at the same time: the server
        // treats a second upload of the same capture name as the same job.
        let folder = try Self.replayCapture(in: tmp.appendingPathComponent("captures", isDirectory: true),
                                            date: Date().addingTimeInterval(-Double.random(in: 86_400...31_000_000)))
        let capture = folder.lastPathComponent
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let store = ProcessingStore(directory: support, uploaderIdentifier: "com.salehtl.nookscan.tests.\(UUID().uuidString)")

        store.send(folder: folder, to: server)
        var sawUpload = false
        let deadline = Date().addingTimeInterval(Self.jobTimeout)
        while true {
            let phase = store.phase(for: capture)
            if case .uploading = phase { sawUpload = true }
            if case .processing = phase { sawUpload = true }
            if case .failed(let message) = phase { Issue.record("send didn't work: \(message)"); return }
            if case .finished = phase { break }
            try #require(Date() < deadline, "no result in \(Int(Self.jobTimeout)) s (phase \(phase))")
            try await Task.sleep(for: .milliseconds(200))
        }
        #expect(sawUpload)
        guard case .finished(let job) = store.phase(for: capture) else { return }
        #expect(job.status == .done)
        #expect(job.result?.roomUrl == "/planner/?room=\(job.name)")
        #expect(store.roomURL(for: capture)?.absoluteString == server.absoluteString + "/planner/?room=\(job.name)")
        #expect(!store.phase(for: capture).canSend, "a done job isn't sent again")

        // The job ID lives outside the capture folder and survives a new store (an app relaunch).
        let records = JobRecords.load(from: support.appendingPathComponent("server-jobs.json"))
        #expect(records.byCapture[capture]?.jobId == job.id)
        #expect(records.byCapture[capture]?.server == server)
        #expect(!FileManager.default.fileExists(atPath: folder.appendingPathComponent("server-jobs.json").path))
        let relaunched = ProcessingStore(directory: support, uploaderIdentifier: "com.salehtl.nookscan.tests.\(UUID().uuidString)")
        #expect(relaunched.phase(for: capture) == .finished(job))
    }

    // MARK: Unit

    @Test func serverURLsAreNormalized() {
        #expect(ServerSettings.normalized("nook.salehtl.com")?.absoluteString == "https://nook.salehtl.com")
        #expect(ServerSettings.normalized(" https://nook.salehtl.com/ ")?.absoluteString == "https://nook.salehtl.com")
        #expect(ServerSettings.normalized("http://127.0.0.1:8798")?.absoluteString == "http://127.0.0.1:8798")
        #expect(ServerSettings.normalized("https://example.com/nook/")?.absoluteString == "https://example.com/nook")
        #expect(ServerSettings.normalized("") == nil)
        #expect(ServerSettings.normalized("ftp://nook.salehtl.com") == nil)
        #expect(ServerSettings.normalized("https://") == nil)
        #expect(ServerSettings.defaultURL == "https://nook.salehtl.com")
    }

    @Test func endpointsAndRoomURL() throws {
        let c = ServerClient(base: try #require(URL(string: "https://nook.salehtl.com")))
        #expect(c.host == "nook.salehtl.com")
        #expect(c.endpoint("health").absoluteString == "https://nook.salehtl.com/api/scan/health")
        #expect(c.endpoint("jobs/j-1/cancel").absoluteString == "https://nook.salehtl.com/api/scan/jobs/j-1/cancel")
        #expect(c.siteURL("/planner/")?.absoluteString == "https://nook.salehtl.com/planner/")
        let r = c.uploadRequest()
        #expect(r.httpMethod == "POST")
        #expect(r.url?.absoluteString == "https://nook.salehtl.com/api/scan/captures")
        #expect(r.value(forHTTPHeaderField: "Content-Type") == "application/zip")
        #expect(r.value(forHTTPHeaderField: "X-Nook") == "1", "contract §2.9: mutations carry X-Nook: 1")

        let prefixed = ServerClient(base: try #require(URL(string: "http://127.0.0.1:8798/nook")))
        #expect(prefixed.endpoint("health").absoluteString == "http://127.0.0.1:8798/nook/api/scan/health")
    }

    @Test func connectionErrorsSayWhatToDo() {
        let host = "nook.salehtl.com"
        func message(_ code: URLError.Code) -> String? {
            ServerError.from(URLError(code), host: host).errorDescription
        }
        #expect(message(.cannotConnectToHost) == "Can't reach nook.salehtl.com: is Tailscale on?")
        #expect(message(.cannotFindHost) == "Can't reach nook.salehtl.com: is Tailscale on?")
        #expect(message(.timedOut) == "Can't reach nook.salehtl.com: is Tailscale on?")
        #expect(message(.networkConnectionLost) == "Can't reach nook.salehtl.com: is Tailscale on?")
        #expect(message(.notConnectedToInternet)?.contains("offline") == true)
        #expect(message(.appTransportSecurityRequiresSecureConnection)?.contains("https://") == true)
        #expect(message(.serverCertificateUntrusted)?.contains("certificate") == true)
    }

    @Test func httpErrorsUseTheServersSentence() throws {
        let url = try #require(URL(string: "https://nook.salehtl.com/api/scan/captures"))
        func response(_ status: Int) -> HTTPURLResponse? {
            HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)
        }
        let body = Data(#"{"error": "not a nook-scan capture zip: share it again from the app"}"#.utf8)
        #expect(throws: ServerError.server(host: "h", status: 400, message: "not a nook-scan capture zip: share it again from the app")) {
            try ServerError.check(response(400), data: body, host: "h")
        }
        #expect(throws: ServerError.forbidden(host: "h")) { try ServerError.check(response(403), data: Data("<html>".utf8), host: "h") }
        #expect(throws: ServerError.notNookServer(host: "h")) { try ServerError.check(response(404), data: Data(), host: "h") }
        #expect(throws: ServerError.server(host: "h", status: 502, message: nil)) { try ServerError.check(response(502), data: Data(), host: "h") }
        try ServerError.check(response(202), data: Data(), host: "h")
        #expect(ServerError.forbidden(host: "nook.salehtl.com").errorDescription?.contains("Tailscale") == true)
        #expect(ServerError.server(host: "h", status: 413, message: "capture is larger than 4 GB").errorDescription == "capture is larger than 4 GB")
    }

    @Test func uploadAnswersDecode() throws {
        let c = ServerClient(base: try #require(URL(string: "http://127.0.0.1:8798")))
        let url = c.endpoint("captures")
        let created = HTTPURLResponse(url: url, statusCode: 202, httpVersion: nil, headerFields: nil)
        let job = try c.uploadedJob(response: created, data: Data(JobDecodingTests.queuedJSON.utf8))
        #expect(job.status == .queued)
        let tooBig = HTTPURLResponse(url: url, statusCode: 413, httpVersion: nil, headerFields: nil)
        #expect(throws: ServerError.server(host: "127.0.0.1", status: 413, message: "capture is larger than 4 GB")) {
            try c.uploadedJob(response: tooBig, data: Data(#"{"error": "capture is larger than 4 GB"}"#.utf8))
        }
        #expect(throws: ServerError.notNookServer(host: "127.0.0.1")) {
            try c.uploadedJob(response: created, data: Data("ok".utf8))
        }
    }

    @Test func jobRecordsPersist() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("records-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("server-jobs.json")
        #expect(JobRecords.load(from: file) == JobRecords(), "no file yet: no records")
        var records = JobRecords()
        let job = try ServerJSON.decoder().decode(ScanJob.self, from: Data(JobDecodingTests.queuedJSON.utf8))
        records.byCapture["scan-20261026-093654"] = JobRecord(jobId: job.id, server: try #require(URL(string: "https://nook.salehtl.com")), job: job)
        records.byCapture["Scan-Renamed_In_Files"] = JobRecord(jobId: "j-2", server: try #require(URL(string: "http://127.0.0.1:8798")))
        try records.save(to: file)
        #expect(JobRecords.load(from: file) == records, "capture names survive as written")
    }

    @Test func uploadTagSurvivesTheTaskDescription() throws {
        let tag = Uploader.Tag(capture: "scan-20261026-093654", server: try #require(URL(string: "https://nook.salehtl.com")))
        let task = URLSession.shared.dataTask(with: try #require(URL(string: "https://nook.salehtl.com")))
        task.taskDescription = tag.encoded
        #expect(Uploader.Tag(task) == tag)
    }

    @Test func sendPhases() throws {
        let job = try ServerJSON.decoder().decode(ScanJob.self, from: Data(JobDecodingTests.queuedJSON.utf8))
        #expect(SendPhase.idle.canSend)
        #expect(SendPhase.failed("x").canSend)
        #expect(!SendPhase.uploading(0.5).canSend)
        #expect(!SendPhase.processing(job, warning: nil).canSend)
    }

    // MARK: Helpers

    /// Replays fixtures/capture-small into a new `scan-YYYYMMDD-HHMMSS` folder, as a real scan would be saved.
    static func replayCapture(in root: URL, date: Date = Date()) throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let folder = CaptureStore.newCaptureFolder(in: root, date: date)
        _ = try ReplayCaptureSource(folder: ReplayCaptureTests.fixture).record(into: folder)
        return folder
    }

    /// Uploads the staged zip and waits for the server's answer, collecting progress on the way. A watchdog
    /// cancels a stalled upload so the test fails instead of hanging.
    @MainActor
    static func upload(_ capture: String, with uploader: Uploader, to server: URL) async -> (Result<ScanJob, ServerError>, [Double]) {
        var fractions: [Double] = []
        let watchdog = Task {
            try await Task.sleep(for: .seconds(180))
            uploader.cancel(capture: capture)
        }
        defer { watchdog.cancel() }
        let result = await withCheckedContinuation { (done: CheckedContinuation<Result<ScanJob, ServerError>, Never>) in
            uploader.onEvent = { event in
                switch event {
                case .progress(_, let f):
                    fractions.append(f)
                case .finished(_, _, let r):
                    uploader.onEvent = nil
                    done.resume(returning: r)
                }
            }
            uploader.upload(capture: capture, to: server)
        }
        return (result, fractions)
    }
}
