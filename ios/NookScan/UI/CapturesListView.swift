import SwiftUI

struct CapturesListView: View {
    @EnvironmentObject private var store: CaptureStore
    @Environment(ProcessingStore.self) private var processing
    @State private var activeCapture: CaptureController?
    @State private var sendTarget: CaptureEntry?
    @State private var showSettings = false
    @State private var shareItem: ShareItem?
    @State private var zipping: String?
    @State private var pendingDelete: CaptureEntry?
    @State private var alert: String?

    var body: some View {
        NavigationStack {
            Group {
                if store.captures.isEmpty {
                    ContentUnavailableView("No captures yet", systemImage: "camera.viewfinder",
                                           description: Text("Tap New Scan and walk slowly around the room."))
                } else {
                    List {
                        ForEach(store.captures) { entry in
                            CaptureRow(entry: entry, isZipping: zipping == entry.id, phase: processing.phase(for: entry.id)) {
                                share(entry)
                            }
                                .contentShape(Rectangle())
                                .onTapGesture { if entry.isComplete { sendTarget = entry } }
                                .swipeActions {
                                    Button(role: .destructive) { pendingDelete = entry } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                    if entry.isComplete {
                                        Button { share(entry) } label: { Label("Share", systemImage: "square.and.arrow.up") }
                                            .tint(.blue)
                                        Button { sendTarget = entry } label: { Label("Send", systemImage: "paperplane") }
                                            .tint(.indigo)
                                    }
                                }
                                .contextMenu {
                                    if entry.isComplete {
                                        Button { sendTarget = entry } label: { Label("Send to server", systemImage: "paperplane") }
                                        if let url = processing.roomURL(for: entry.id) {
                                            Link(destination: url) { Label("Open room", systemImage: "safari") }
                                        }
                                        Button { share(entry) } label: { Label("Share as .zip", systemImage: "square.and.arrow.up") }
                                    }
                                    Button(role: .destructive) { pendingDelete = entry } label: { Label("Delete", systemImage: "trash") }
                                }
                                .accessibilityAction(named: "Send to server") { if entry.isComplete { sendTarget = entry } }
                        }
                    }
                    .refreshable { store.refresh() }
                }
            }
            .navigationTitle("Captures")
            .toolbar {
                #if DEBUG
                ToolbarItem(placement: .topBarLeading) {
                    Button("Replay sample", systemImage: "arrow.triangle.2.circlepath.camera") { startReplay() }
                }
                #endif
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Settings", systemImage: "gearshape") { showSettings = true }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button(action: startLive) {
                    Label("New Scan", systemImage: "camera.viewfinder")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding()
                .background(.bar)
            }
        }
        .onAppear { store.refresh() }
        .fullScreenCover(item: $activeCapture, onDismiss: { store.refresh() }) { controller in
            CaptureView(controller: controller)
        }
        .sheet(item: $shareItem, onDismiss: { CaptureStore.clearShareFolder() }) { item in
            ShareSheet(items: [item.url])
        }
        .sheet(item: $sendTarget) { entry in
            SendToServerView(entry: entry)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .confirmationDialog("Delete this capture?",
                            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                            titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let entry = pendingDelete {
                    processing.forget(capture: entry.id)
                    store.delete(entry)
                }
                pendingDelete = nil
            }
        } message: {
            Text("\(pendingDelete?.name ?? "The capture") will be removed from this iPhone. This can't be undone.")
        }
        .alert(alert ?? "", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }

    private func startLive() {
        guard LiveCaptureSource.isSupported else {
            alert = "This device can't run ARKit world tracking. Use a real iPhone (LiDAR recommended)."
            return
        }
        activeCapture = CaptureController(source: LiveCaptureSource(), capturesRoot: store.root)
    }

    #if DEBUG
    private func startReplay() {
        guard let url = Bundle.main.url(forResource: "capture-small", withExtension: nil) else {
            alert = "The sample capture isn't bundled in this build."
            return
        }
        do {
            activeCapture = CaptureController(source: try ReplayCaptureSource(folder: url, timeScale: 2.5), capturesRoot: store.root)
        } catch {
            alert = error.localizedDescription
        }
    }
    #endif

    private func share(_ entry: CaptureEntry) {
        guard zipping == nil else { return }
        zipping = entry.id
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try CaptureStore.makeZip(of: entry.url) }
            DispatchQueue.main.async {
                zipping = nil
                switch result {
                case .success(let url): shareItem = ShareItem(url: url)
                case .failure(let error): alert = "Couldn't zip \(entry.name): \(error.localizedDescription)"
                }
            }
        }
    }
}

private struct CaptureRow: View {
    let entry: CaptureEntry
    let isZipping: Bool
    let phase: SendPhase
    let share: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.name)
                    .font(.body.monospacedDigit())
                HStack(spacing: 6) {
                    if let n = entry.frameCount {
                        Text("\(n) frames")
                            .foregroundStyle(n < CaptureController.minFrames ? .orange : .secondary)
                    } else {
                        Text("Incomplete").foregroundStyle(.orange)
                    }
                    Text("·")
                    Text(ByteCountFormatter.string(fromByteCount: entry.sizeBytes, countStyle: .file))
                    if entry.lidar {
                        Text("LiDAR")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.accentColor.opacity(0.18), in: Capsule())
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                if let date = entry.date {
                    Text(date, format: .dateTime.year().month(.abbreviated).day().hour().minute())
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let (text, icon, color) = serverStatus {
                    HStack(spacing: 4) {
                        Image(systemName: icon)
                        Text(text)
                    }
                    .font(.footnote.weight(.medium).monospacedDigit())
                    .foregroundStyle(color)
                    .lineLimit(1)
                }
            }
            Spacer()
            if entry.isComplete {
                if isZipping {
                    ProgressView()
                } else {
                    Button(action: share) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Share \(entry.name) as zip")
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// One line about the capture's server job, or nil when it was never sent.
    private var serverStatus: (String, String, Color)? {
        switch phase {
        case .idle: nil
        case .preparing: ("Preparing upload…", "arrow.up.circle", .secondary)
        case .uploading(let f): ("Uploading \(Int((f * 100).rounded(.down)))%", "arrow.up.circle", .blue)
        case .processing(let job, let warning): (job.shortStatus, warning == nil ? "gearshape.2" : "wifi.exclamationmark", warning == nil ? .blue : .orange)
        case .finished(let job): (job.shortStatus, job.status == .done ? "checkmark.circle.fill" : "xmark.circle", job.status == .done ? .green : .secondary)
        case .failed: ("Send failed: tap for details", "exclamationmark.triangle", .orange)
        }
    }
}

struct ShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
