import Foundation

/// Why a request to the processing server didn't work, phrased as what to do about it.
enum ServerError: Error, Equatable {
    case invalidURL(String)
    /// No connection at all: DNS, refused, timed out. On the tailnet-only server, that's almost always Tailscale.
    case unreachable(host: String)
    case offline(host: String)
    /// Plain http to a non-local host, blocked by App Transport Security.
    case needsHTTPS(host: String)
    case untrusted(host: String)
    /// 401/403: the proxy turned us away (not on the tailnet, or not signed in).
    case forbidden(host: String)
    /// Something answered, but not the nook-scan API.
    case notNookServer(host: String)
    case jobNotFound
    /// The server's own `{"error": …}` sentence, or just the status.
    case server(host: String, status: Int, message: String?)
    case unexpected(host: String, detail: String)
}

extension ServerError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .invalidURL(let text):
            "“\(text)” isn't a server URL. Use one like \(ServerSettings.defaultURL)."
        case .unreachable(let host):
            "Can't reach \(host): is Tailscale on?"
        case .offline(let host):
            "Can't reach \(host): this iPhone is offline (or Local Network access is off in Settings › Nook Scan)."
        case .needsHTTPS(let host):
            "Use https:// for \(host). Plain http only works for local addresses."
        case .untrusted(let host):
            "Can't connect securely to \(host): its certificate isn't trusted. Check the server URL in Settings."
        case .forbidden(let host):
            "\(host) turned this iPhone away: is Tailscale on and signed in?"
        case .notNookServer(let host):
            "\(host) answered, but it isn't a nook-scan server. Check the server URL in Settings."
        case .jobNotFound:
            "The server no longer has this job. Send the capture again."
        case .server(let host, let status, let message):
            message ?? "\(host) answered with an error (HTTP \(status)). Try again in a moment."
        case .unexpected(let host, let detail):
            "Unexpected answer from \(host): \(detail)"
        }
    }

    /// Maps URLSession and decoding errors to an actionable ServerError.
    static func from(_ error: Error, host: String) -> ServerError {
        if let e = error as? ServerError { return e }
        if error is DecodingError { return .notNookServer(host: host) }
        guard let u = error as? URLError else { return .unexpected(host: host, detail: error.localizedDescription) }
        switch u.code {
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
            return .offline(host: host)
        case .appTransportSecurityRequiresSecureConnection:
            return .needsHTTPS(host: host)
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid,
             .serverCertificateHasUnknownRoot, .clientCertificateRejected, .clientCertificateRequired:
            return .untrusted(host: host)
        case .badServerResponse, .cannotParseResponse, .cannotDecodeContentData, .cannotDecodeRawData:
            return .notNookServer(host: host)
        default:
            return .unreachable(host: host)
        }
    }

    /// Checks an HTTP response: 2xx passes, anything else becomes a ServerError with the server's own message.
    static func check(_ response: URLResponse?, data: Data, host: String) throws(ServerError) {
        guard let http = response as? HTTPURLResponse else { throw .unexpected(host: host, detail: "no HTTP response") }
        guard !(200..<300).contains(http.statusCode) else { return }
        if let message = try? ServerJSON.decoder().decode(ServerErrorBody.self, from: data).error {
            throw .server(host: host, status: http.statusCode, message: message)
        }
        switch http.statusCode {
        case 401, 403: throw .forbidden(host: host)
        case 404: throw .notNookServer(host: host)
        default: throw .server(host: host, status: http.statusCode, message: nil)
        }
    }
}

/// The processing server URL (Settings). Stored in UserDefaults under `key`.
enum ServerSettings {
    static let key = "serverURL"
    static let defaultURL = "https://nook.salehtl.com"

    /// The configured server, normalized.
    static var current: URL {
        normalized(UserDefaults.standard.string(forKey: key) ?? defaultURL) ?? URL(string: defaultURL)!
    }

    /// `nook.salehtl.com` → `https://nook.salehtl.com`; trims spaces and trailing slashes. nil if it isn't an
    /// http(s) URL with a host.
    static func normalized(_ text: String) -> URL? {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        if !t.contains("://") { t = "https://" + t }
        while t.hasSuffix("/") { t.removeLast() }
        guard let url = URL(string: t), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host(), !host.isEmpty, url.query == nil, url.fragment == nil else { return nil }
        return url
    }
}

/// The processing server's JSON API (contract §5). Uploads go through `Uploader` (a background session); this
/// covers the small requests.
struct ServerClient {
    let base: URL
    var session: URLSession = .shared

    var host: String { base.host() ?? base.absoluteString }

    /// `base` + `/api/scan/...`, keeping any path prefix the base has.
    func endpoint(_ path: String) -> URL {
        base.appending(path: "api/scan").appending(path: path)
    }

    /// The upload request for a capture zip (`POST /api/scan/captures`). The body is the zip file; URLSession
    /// sets Content-Length from it.
    func uploadRequest() -> URLRequest {
        var r = URLRequest(url: endpoint("captures"))
        r.httpMethod = "POST"
        r.setValue("application/zip", forHTTPHeaderField: "Content-Type")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        return r
    }

    /// A site path from the server (e.g. `result.room_url` "/planner/") as a full URL on the same origin.
    func siteURL(_ path: String) -> URL? {
        URL(string: path, relativeTo: base)?.absoluteURL
    }

    func health() async throws(ServerError) -> ServerHealth {
        let h: ServerHealth = try await get("health", timeout: 10)
        guard h.ok else { throw .unexpected(host: host, detail: "health check says the server isn't ok") }
        return h
    }

    func job(_ id: String) async throws(ServerError) -> ScanJob {
        do {
            return try await get("jobs/\(id)", timeout: 15)
        } catch .server(_, 404, _) {
            throw .jobNotFound
        }
    }

    func cancel(_ id: String) async throws(ServerError) -> ScanJob {
        var r = URLRequest(url: endpoint("jobs/\(id)/cancel"), timeoutInterval: 15)
        r.httpMethod = "POST"
        return try await send(r)
    }

    /// Decodes the answer to an upload (`202 {job}` new, `200 {job}` existing, or an error).
    func uploadedJob(response: URLResponse?, data: Data) throws(ServerError) -> ScanJob {
        try ServerError.check(response, data: data, host: host)
        do { return try ServerJSON.decoder().decode(ScanJob.self, from: data) } catch { throw .notNookServer(host: host) }
    }

    private func get<T: Decodable>(_ path: String, timeout: TimeInterval) async throws(ServerError) -> T {
        var r = URLRequest(url: endpoint(path), timeoutInterval: timeout)
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await send(r)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws(ServerError) -> T {
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) } catch { throw .from(error, host: host) }
        try ServerError.check(response, data: data, host: host)
        do { return try ServerJSON.decoder().decode(T.self, from: data) } catch { throw .notNookServer(host: host) }
    }
}
