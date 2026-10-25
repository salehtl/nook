import Foundation

struct CaptureEntry: Identifiable, Hashable {
    let url: URL
    var id: String { url.lastPathComponent }
    var name: String { url.lastPathComponent }
    /// nil when meta.json is missing (an interrupted capture).
    let frameCount: Int?
    let sizeBytes: Int64
    let date: Date?
    let lidar: Bool

    var isComplete: Bool { frameCount != nil }
}

/// Captures live as `scan-YYYYMMDD-HHMMSS` folders directly in Documents (also visible in the Files app).
final class CaptureStore: ObservableObject {
    @Published private(set) var captures: [CaptureEntry] = []
    let root: URL

    init(root: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]) {
        self.root = root
    }

    /// Re-reads the folder off the main thread (sizes need a directory walk).
    func refresh() {
        let root = self.root
        DispatchQueue.global(qos: .userInitiated).async {
            let list = Self.scan(root)
            DispatchQueue.main.async { self.captures = list }
        }
    }

    func delete(_ entry: CaptureEntry) {
        try? FileManager.default.removeItem(at: entry.url)
        captures.removeAll { $0.id == entry.id }
    }

    static func scan(_ root: URL) -> [CaptureEntry] {
        let fm = FileManager.default
        let names = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
        return names.filter { $0.hasPrefix("scan-") }.sorted(by: >).compactMap { name in
            let url = root.appendingPathComponent(name, isDirectory: true)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else { return nil }
            let meta = (try? Data(contentsOf: url.appendingPathComponent("meta.json")))
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let created = (meta?["created"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) }
            return CaptureEntry(url: url,
                                frameCount: meta?["frame_count"] as? Int,
                                sizeBytes: folderSize(url),
                                date: created ?? dateFromName(name),
                                lidar: meta?["lidar"] as? Bool ?? false)
        }
    }

    static func folderSize(_ url: URL) -> Int64 {
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let f as URL in e {
            total += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return total
    }

    private static let nameFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f
    }()

    static func dateFromName(_ name: String) -> Date? {
        nameFormatter.date(from: String(name.dropFirst("scan-".count).prefix(15)))
    }

    /// A new, not-yet-existing `scan-YYYYMMDD-HHMMSS` folder URL (local time).
    static func newCaptureFolder(in root: URL, date: Date = Date()) -> URL {
        var d = date
        while true {
            let url = root.appendingPathComponent("scan-" + nameFormatter.string(from: d), isDirectory: true)
            if !FileManager.default.fileExists(atPath: url.path) { return url }
            d.addTimeInterval(1)
        }
    }

    /// Zips a capture folder for sharing: `<name>.zip` whose single top-level entry is the folder (contract §4.1).
    /// Uses NSFileCoordinator's `.forUploading`, which zips a directory. Slow for big captures: call off main.
    static func makeZip(of folder: URL) throws -> URL {
        let fm = FileManager.default
        let outDir = fm.temporaryDirectory.appendingPathComponent("Share", isDirectory: true)
        try fm.createDirectory(at: outDir, withIntermediateDirectories: true)
        let out = outDir.appendingPathComponent(folder.lastPathComponent + ".zip")
        try? fm.removeItem(at: out)
        var coordError: NSError?
        var copyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: folder, options: .forUploading, error: &coordError) { zipURL in
            do { try fm.copyItem(at: zipURL, to: out) } catch { copyError = error }
        }
        if let e = coordError ?? copyError { throw e }
        return out
    }

    static func clearShareFolder() {
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("Share"))
    }
}
