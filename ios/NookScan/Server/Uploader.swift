import Foundation

/// Uploads capture zips to the processing server with a background URLSession, so an upload keeps going while
/// the app is in the background or suspended. Events arrive on the main queue through `onEvent`.
final class Uploader: NSObject, URLSessionDataDelegate {
    enum Event {
        case progress(capture: String, fraction: Double)
        case finished(capture: String, server: URL, result: Result<ScanJob, ServerError>)
    }

    /// What a task uploads, kept in `taskDescription` so it survives an app relaunch.
    struct Tag: Codable, Equatable {
        var capture: String
        var server: URL

        init(capture: String, server: URL) {
            self.capture = capture
            self.server = server
        }

        init?(_ task: URLSessionTask) {
            guard let d = task.taskDescription?.data(using: .utf8),
                  let tag = try? JSONDecoder().decode(Tag.self, from: d) else { return nil }
            self = tag
        }

        var encoded: String {
            (try? JSONEncoder().encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        }
    }

    static let appSessionIdentifier = "com.salehtl.nookscan.upload"

    let identifier: String
    /// Where zips wait until their upload ends (then they're deleted).
    let zipFolder: URL
    /// Called on the main queue.
    var onEvent: ((Event) -> Void)?
    /// The system's completion handler from `handleEventsForBackgroundURLSession`, called once events are delivered.
    var backgroundCompletion: (() -> Void)?

    private var session: URLSession!
    // Touched only on the session's serial delegate queue.
    private var bodies: [Int: Data] = [:]
    private var reported: [Int: Double] = [:]

    init(identifier: String = Uploader.appSessionIdentifier, zipFolder: URL) {
        self.identifier = identifier
        self.zipFolder = zipFolder
        super.init()
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        // The server writes and validates the whole upload before it answers.
        config.timeoutIntervalForRequest = 300
        config.timeoutIntervalForResource = 6 * 3600
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
    }

    /// The staged zip for `capture` (contract §4.1: `<capture>.zip` with the folder as its single top entry).
    func zipURL(for capture: String) -> URL {
        zipFolder.appendingPathComponent(capture + ".zip")
    }

    /// Uploads the staged zip for `capture`. Progress and the server's answer arrive through `onEvent`.
    func upload(capture: String, to server: URL) {
        let task = session.uploadTask(with: ServerClient(base: server).uploadRequest(), fromFile: zipURL(for: capture))
        task.taskDescription = Tag(capture: capture, server: server).encoded
        task.resume()
    }

    /// Uploads still in flight (for example after a relaunch), as capture → fraction sent.
    func activeUploads() async -> [String: Double] {
        var out: [String: Double] = [:]
        for task in await session.allTasks where task.state == .running || task.state == .suspended {
            guard let tag = Tag(task) else { continue }
            let total = task.countOfBytesExpectedToSend
            out[tag.capture] = total > 0 ? Double(task.countOfBytesSent) / Double(total) : 0
        }
        return out
    }

    func cancel(capture: String) {
        session.getAllTasks { tasks in
            for task in tasks where Tag(task)?.capture == capture { task.cancel() }
        }
    }

    /// Ends the session (tests). The app's session lives as long as the app.
    func invalidate() {
        session.invalidateAndCancel()
    }

    // MARK: URLSessionDataDelegate (on the delegate queue)

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard let tag = Tag(task), totalBytesExpectedToSend > 0 else { return }
        let f = min(1, Double(totalBytesSent) / Double(totalBytesExpectedToSend))
        // About 200 updates per upload at most.
        guard f >= 1 || f - (reported[task.taskIdentifier] ?? -1) >= 0.005 else { return }
        reported[task.taskIdentifier] = f
        emit(.progress(capture: tag.capture, fraction: f))
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        bodies[dataTask.taskIdentifier, default: Data()].append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let body = bodies.removeValue(forKey: task.taskIdentifier) ?? Data()
        reported[task.taskIdentifier] = nil
        guard let tag = Tag(task) else { return }
        try? FileManager.default.removeItem(at: zipURL(for: tag.capture))
        let client = ServerClient(base: tag.server)
        let result: Result<ScanJob, ServerError>
        if let error {
            result = .failure(.from(error, host: client.host))
        } else {
            do { result = .success(try client.uploadedJob(response: task.response, data: body)) } catch { result = .failure(error) }
        }
        emit(.finished(capture: tag.capture, server: tag.server, result: result))
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            self.backgroundCompletion?()
            self.backgroundCompletion = nil
        }
    }

    private func emit(_ event: Event) {
        DispatchQueue.main.async { self.onEvent?(event) }
    }
}
