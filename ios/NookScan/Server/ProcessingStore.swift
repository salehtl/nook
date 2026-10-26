import Foundation
import Observation

/// Where sending one capture to the processing server stands.
enum SendPhase: Equatable {
    case idle
    /// Checking the server, then zipping. The text says which.
    case preparing(String)
    /// Fraction of the zip sent.
    case uploading(Double)
    /// Queued or training on the server. `warning`: the last status check didn't get through.
    case processing(ScanJob, warning: String?)
    /// Done, failed or cancelled on the server.
    case finished(ScanJob)
    /// Couldn't send (server unreachable, zip failed, upload rejected).
    case failed(String)

    /// Whether Send is available: nothing is in flight and no live job holds the capture.
    var canSend: Bool {
        switch self {
        case .idle, .failed: true
        case .finished(let job): job.status != .done
        case .preparing, .uploading, .processing: false
        }
    }
}

/// The server job for a capture, stored outside the capture folder (contract §5 job IDs, per capture).
struct JobRecord: Codable, Equatable {
    var jobId: String
    var server: URL
    /// Last known state, so a finished job shows without a network round trip.
    var job: ScanJob?
}

/// All job records, as one small JSON file in Application Support. Stored as a list: capture names are data, not
/// JSON keys (the snake_case key strategy would rewrite them).
struct JobRecords: Codable, Equatable {
    var byCapture: [String: JobRecord] = [:]

    init() {}

    private struct Entry: Codable {
        var capture: String
        var record: JobRecord
    }

    private enum CodingKeys: String, CodingKey { case jobs }

    init(from decoder: Decoder) throws {
        let entries = try decoder.container(keyedBy: CodingKeys.self).decode([Entry].self, forKey: .jobs)
        byCapture = Dictionary(entries.map { ($0.capture, $0.record) }, uniquingKeysWith: { _, last in last })
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(byCapture.sorted { $0.key < $1.key }.map { Entry(capture: $0.key, record: $0.value) }, forKey: .jobs)
    }

    static func load(from url: URL) -> JobRecords {
        guard let data = try? Data(contentsOf: url),
              let records = try? ServerJSON.decoder().decode(JobRecords.self, from: data) else { return JobRecords() }
        return records
    }

    func save(to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try ServerJSON.encoder().encode(self).write(to: url, options: .atomic)
    }
}

/// Sends captures to the processing server and follows their jobs: health check → zip → background upload →
/// job polling (contract §5). One shared instance, since the background upload session is app-wide.
@MainActor
@Observable
final class ProcessingStore {
    static let shared = ProcessingStore()

    private(set) var phases: [String: SendPhase] = [:]

    @ObservationIgnored private var records: JobRecords
    @ObservationIgnored private let recordsURL: URL
    @ObservationIgnored private let uploader: Uploader
    @ObservationIgnored private var polls: [String: Task<Void, Never>] = [:]
    /// Uploads that made no progress for `stallAfter` seconds (server down, Tailscale off). They resume on their own.
    private(set) var stalledUploads: Set<String> = []
    static let stallAfter: TimeInterval = 90   // generous: the server validates a big capture before it answers
    /// The latest send per capture: a check or zip from a cancelled send must not carry on after a new one starts.
    @ObservationIgnored private var sendTokens: [String: UUID] = [:]
    @ObservationIgnored private var lastProgress: [String: Date] = [:]
    @ObservationIgnored private var watchdogs: [String: Task<Void, Never>] = [:]

    init(directory: URL = ProcessingStore.defaultDirectory, uploaderIdentifier: String = Uploader.appSessionIdentifier) {
        recordsURL = directory.appendingPathComponent("server-jobs.json")
        records = JobRecords.load(from: recordsURL)
        uploader = Uploader(identifier: uploaderIdentifier, zipFolder: directory.appendingPathComponent("Uploads", isDirectory: true))
        uploader.onEvent = { [weak self] event in self?.handle(event) }
        for (capture, record) in records.byCapture {
            guard let job = record.job else { continue }
            phases[capture] = job.status.isFinished ? .finished(job) : .processing(job, warning: nil)
            if !job.status.isFinished { poll(capture) }
        }
        Task { [uploader] in
            for (capture, fraction) in await uploader.activeUploads() { phases[capture] = .uploading(fraction) }
        }
    }

    /// Application Support/Processing: outside Documents, so it isn't mistaken for a capture or shared in Files.
    nonisolated static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Processing", isDirectory: true)
    }

    func phase(for capture: String) -> SendPhase {
        phases[capture] ?? .idle
    }

    /// The server a capture was sent to, if any.
    func server(for capture: String) -> URL? {
        records.byCapture[capture]?.server
    }

    /// The trained room in the web app: the server's origin + `result.room_url`.
    func roomURL(for capture: String) -> URL? {
        guard let record = records.byCapture[capture], let job = record.job, job.status == .done else { return nil }
        return ServerClient(base: record.server).siteURL(job.result?.roomUrl ?? "/planner/")
    }

    /// Checks the server, zips the capture and starts the background upload.
    func send(folder: URL, to server: URL) {
        let capture = folder.lastPathComponent
        guard phase(for: capture).canSend else { return }
        let client = ServerClient(base: server)
        let token = UUID()
        sendTokens[capture] = token
        phases[capture] = .preparing("Checking \(client.host)…")
        Task {
            // A background upload to an unreachable host waits instead of failing, so fail fast here instead.
            do { _ = try await client.health() } catch {
                if sendTokens[capture] == token { phases[capture] = .failed(error.localizedDescription) }
                return
            }
            guard sendTokens[capture] == token, case .preparing = phase(for: capture) else { return }
            phases[capture] = .preparing("Zipping…")
            do { try await Self.zip(folder, into: uploader.zipFolder) } catch {
                if sendTokens[capture] == token { phases[capture] = .failed("Couldn't zip \(capture): \(error.localizedDescription)") }
                return
            }
            guard sendTokens[capture] == token, case .preparing = phase(for: capture) else { return }
            phases[capture] = .uploading(0)
            startWatchdog(capture)
            uploader.upload(capture: capture, to: server)
        }
    }

    /// Stops a check, zip or upload in progress. A job already on the server is cancelled with `cancelJob`.
    func cancelSend(capture: String) {
        switch phase(for: capture) {
        case .preparing, .uploading:
            sendTokens[capture] = nil
            stopWatchdog(capture)
            uploader.cancel(capture: capture)
            phases[capture] = .idle
        default:
            break
        }
    }

    func cancelJob(capture: String) {
        guard let record = records.byCapture[capture] else { return }
        Task {
            do {
                let job = try await ServerClient(base: record.server).cancel(record.jobId)
                update(capture, job: job)
            } catch {
                if case .processing(let job, _) = phase(for: capture) {
                    phases[capture] = .processing(job, warning: error.localizedDescription)
                }
            }
        }
    }

    /// Checks the job again now (pull to refresh, or the send sheet appearing).
    func refresh(capture: String) {
        guard let record = records.byCapture[capture], record.job?.status.isFinished != true else { return }
        poll(capture)
    }

    /// Drops everything about a capture (it was deleted). The server keeps its job and room.
    func forget(capture: String) {
        sendTokens[capture] = nil
        stopWatchdog(capture)
        polls.removeValue(forKey: capture)?.cancel()
        uploader.cancel(capture: capture)
        phases[capture] = nil
        records.byCapture[capture] = nil
        saveRecords()
    }

    /// From the app delegate, when iOS relaunches the app for upload events.
    func handleBackgroundEvents(identifier: String, completion: @escaping () -> Void) {
        guard identifier == uploader.identifier else { return completion() }
        uploader.backgroundCompletion = completion
    }

    // MARK: Private

    private func handle(_ event: Uploader.Event) {
        switch event {
        case .progress(let capture, let fraction):
            guard case .uploading = phase(for: capture) else { return }
            lastProgress[capture] = Date()
            stalledUploads.remove(capture)
            phases[capture] = .uploading(fraction)
        case .finished(let capture, let server, .success(let job)):
            stopWatchdog(capture)
            records.byCapture[capture] = JobRecord(jobId: job.id, server: server, job: job)
            saveRecords()
            update(capture, job: job)
            if !job.status.isFinished { poll(capture) }
        case .finished(let capture, _, .failure(let error)):
            stopWatchdog(capture)
            // A cancelled upload already went back to idle.
            guard case .uploading = phase(for: capture) else { return }
            phases[capture] = .failed(error.localizedDescription)
        }
    }

    /// Flags an upload that stops making progress, so the sheet can say why instead of sitting at "Uploading 100%".
    private func startWatchdog(_ capture: String) {
        lastProgress[capture] = Date()
        watchdogs[capture]?.cancel()
        watchdogs[capture] = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard let self, case .uploading = self.phase(for: capture) else { return }
                if Date().timeIntervalSince(self.lastProgress[capture] ?? Date()) > Self.stallAfter {
                    self.stalledUploads.insert(capture)
                }
            }
        }
    }

    private func stopWatchdog(_ capture: String) {
        watchdogs.removeValue(forKey: capture)?.cancel()
        stalledUploads.remove(capture)
    }

    private func update(_ capture: String, job: ScanJob) {
        phases[capture] = job.status.isFinished ? .finished(job) : .processing(job, warning: nil)
        guard var record = records.byCapture[capture], record.jobId == job.id, record.job != job else { return }
        let statusChanged = record.job?.status != job.status
        record.job = job
        records.byCapture[capture] = record
        if statusChanged || job.status.isFinished { saveRecords() }
    }

    /// Follows a job every 2 s (5 s after an error) until it finishes. Runs while the app is in the foreground.
    private func poll(_ capture: String) {
        polls[capture]?.cancel()
        polls[capture] = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let record = records.byCapture[capture] else { return }
                var delay = 2.0
                do {
                    let job = try await ServerClient(base: record.server).job(record.jobId)
                    guard !Task.isCancelled else { return }
                    update(capture, job: job)
                    if job.status.isFinished { return }
                } catch ServerError.jobNotFound {
                    records.byCapture[capture] = nil
                    saveRecords()
                    phases[capture] = .failed(ServerError.jobNotFound.localizedDescription)
                    return
                } catch {
                    guard !Task.isCancelled else { return }
                    if let job = records.byCapture[capture]?.job {
                        phases[capture] = .processing(job, warning: error.localizedDescription)
                    }
                    delay = 5
                }
                try? await Task.sleep(for: .seconds(delay))
            }
        }
    }

    private func saveRecords() {
        try? records.save(to: recordsURL)
    }

    @concurrent
    private nonisolated static func zip(_ folder: URL, into dir: URL) async throws {
        _ = try CaptureStore.makeZip(of: folder, into: dir)
    }
}
