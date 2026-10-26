import SwiftUI

/// Sends one saved capture to the processing server and follows its job: upload progress, then stage, percent and
/// time left, then Open room (contract §5).
struct SendToServerView: View {
    let entry: CaptureEntry
    @Environment(ProcessingStore.self) private var processing
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @AppStorage(ServerSettings.key) private var serverText = ServerSettings.defaultURL
    @State private var showSettings = false

    private var phase: SendPhase { processing.phase(for: entry.id) }
    private var settingsServer: URL? { ServerSettings.normalized(serverText) }
    /// The server this capture went to, or the one it would go to now.
    private var server: URL? { processing.server(for: entry.id) ?? settingsServer }
    private var host: String { server.map { ServerClient(base: $0).host } ?? "the server" }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.name).font(.headline.monospacedDigit())
                    Text(details).font(.footnote).foregroundStyle(.secondary)
                }
                status
                Spacer(minLength: 0)
                actions
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .navigationTitle("Send to server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button("Server settings", systemImage: "gearshape") { showSettings = true }
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .onAppear { processing.refresh(capture: entry.id) }
        }
        .presentationDetents([.medium, .large])
    }

    private var details: String {
        var parts = [ByteCountFormatter.string(fromByteCount: entry.sizeBytes, countStyle: .file)]
        if let n = entry.frameCount { parts.insert("\(n) frames", at: 0) }
        parts.append("to \(host)")
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var status: some View {
        switch phase {
        case .idle:
            Text("Uploads the capture to \(host), which trains the room and adds it to the web app. The upload keeps going if you leave the app.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        case .preparing(let text):
            HStack(spacing: 10) {
                ProgressView()
                Text(text)
            }
        case .uploading(let fraction):
            VStack(alignment: .leading, spacing: 6) {
                Text("Uploading").font(.headline)
                ProgressView(value: fraction)
                Text("\(Int((fraction * 100).rounded(.down)))% of \(ByteCountFormatter.string(fromByteCount: entry.sizeBytes, countStyle: .file)) · keeps going in the background")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        case .processing(let job, let warning):
            JobProgress(job: job)
            if let warning {
                Label(warning, systemImage: "wifi.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        case .finished(let job):
            switch job.status {
            case .done:
                VStack(alignment: .leading, spacing: 6) {
                    Label("Room ready", systemImage: "checkmark.circle.fill")
                        .font(.headline)
                        .foregroundStyle(.green)
                    if let summary = resultSummary(job) {
                        Text(summary).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            default:
                Label(job.message.isEmpty ? job.shortStatus : job.message,
                      systemImage: job.status == .cancelled ? "stop.circle" : "xmark.octagon.fill")
                    .foregroundStyle(job.status == .cancelled ? Color.secondary : Color.red)
            }
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        }
    }

    @ViewBuilder private var actions: some View {
        Group {
            switch phase {
            case .preparing, .uploading:
                Button("Cancel upload", role: .destructive) { processing.cancelSend(capture: entry.id) }
                    .buttonStyle(.bordered)
            case .processing:
                Button("Cancel training", role: .destructive) { processing.cancelJob(capture: entry.id) }
                    .buttonStyle(.bordered)
            case .finished(let job) where job.status == .done:
                if let url = processing.roomURL(for: entry.id) {
                    Button {
                        openURL(url)
                    } label: {
                        Label("Open room", systemImage: "safari").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
            case .idle, .failed, .finished:
                Button {
                    if let settingsServer { processing.send(folder: entry.url, to: settingsServer) }
                } label: {
                    Label(phase == .idle ? "Send to \(host)" : "Send again", systemImage: "paperplane.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(settingsServer == nil || !entry.isComplete)
            }
        }
        .controlSize(.large)
        .frame(maxWidth: .infinity)
    }

    private func resultSummary(_ job: ScanJob) -> String? {
        guard let r = job.result else { return nil }
        var parts: [String] = []
        if let n = r.splats { parts.append("\(n.formatted()) splats") }
        if let s = r.seconds { parts.append("trained in \(Duration.seconds(s).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .abbreviated, maximumUnitCount: 2)))") }
        if let p = r.psnr { parts.append(String(format: "%.1f dB", p)) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// Stage, percent and time left of a running job.
struct JobProgress: View {
    let job: ScanJob

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(job.status == .queued ? "Queued on the server" : job.stage.prefix(1).uppercased() + job.stage.dropFirst())
                .font(.headline)
            ProgressView(value: min(1, max(0, job.progress)))
            HStack {
                Text(percentAndStep)
                Spacer()
                if let left = job.timeLeft { Text(left) }
            }
            .font(.footnote.monospacedDigit())
            .foregroundStyle(.secondary)
            if !job.message.isEmpty {
                Text(job.message).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private var percentAndStep: String {
        let percent = "\(Int((job.progress * 100).rounded(.down)))%"
        guard job.totalSteps > 0, job.step > 0 else { return percent }
        return "\(percent) · step \(job.step.formatted()) of \(job.totalSteps.formatted())"
    }
}
