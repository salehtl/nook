import Foundation

/// Job status from the processing server (contract §5).
enum JobStatus: String, Codable, CaseIterable, Equatable {
    case queued
    case training
    case done
    case failed
    case cancelled

    /// Whether the job has stopped for good (no more progress will come).
    var isFinished: Bool {
        switch self {
        case .queued, .training: false
        case .done, .failed, .cancelled: true
        }
    }
}

/// A training job (contract §5). Decoded with `.convertFromSnakeCase`, so `total_steps` → `totalSteps`.
struct ScanJob: Codable, Equatable, Identifiable {
    let id: String
    let capture: String
    let name: String
    let status: JobStatus
    /// waiting | preparing | building trainer | training | finishing | done. Shown as is.
    let stage: String
    /// 0…1.
    let progress: Double
    let step: Int
    let totalSteps: Int
    /// Seconds left, when the server can estimate it.
    let etaS: Double?
    let created: String
    let started: String?
    let finished: String?
    /// Human-readable status line.
    let message: String
    /// Set when `status` is `done`.
    let result: JobResult?
}

/// The trainer's summary (contract §4.6) plus the site paths of the result (contract §5). Only `room_url` matters
/// to the app; the rest is shown when present.
struct JobResult: Codable, Equatable {
    var name: String?
    var ply: String?
    var roomJson: String?
    var splats: Int?
    var floorY: Double?
    var steps: Int?
    var seconds: Double?
    var trainer: String?
    var psnr: Double?
    /// Site path of the web app showing the room, e.g. "/planner/", on the server the app talked to.
    var roomUrl: String?
    var plyUrl: String?
}

/// `GET /api/scan/health`.
struct ServerHealth: Codable, Equatable {
    let ok: Bool
    let version: String?
    let trainer: String?
    let gpu: String?
    let busy: Bool
    let queued: Int
}

/// `{"error": "<one actionable sentence>"}` on any 4xx/5xx.
struct ServerErrorBody: Codable, Equatable {
    let error: String
}

enum ServerJSON {
    static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        e.outputFormatting = [.sortedKeys]
        return e
    }
}

extension ScanJob {
    /// "Training · 42%" style summary for list rows.
    var shortStatus: String {
        switch status {
        case .queued: "Queued on server"
        case .training: "\(stage.prefix(1).uppercased() + stage.dropFirst()) · \(Int((progress * 100).rounded(.down)))%"
        case .done: "Room ready"
        case .failed: "Training failed"
        case .cancelled: "Cancelled"
        }
    }

    /// "About 4 min left", or nil when unknown.
    var timeLeft: String? {
        guard !status.isFinished, let eta = etaS, eta.isFinite, eta > 0 else { return nil }
        if eta < 60 { return "Less than a minute left" }
        let minutes = Int((eta / 60).rounded(.up))
        if minutes < 90 { return "About \(minutes) min left" }
        return "About \(Int((eta / 3600).rounded())) h left"
    }
}
