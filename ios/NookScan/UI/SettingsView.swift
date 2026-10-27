import SwiftUI

/// The processing server URL and a connection test (`GET /api/scan/health`, contract §5).
struct SettingsView: View {
    enum ConnectionTest: Equatable {
        case idle
        case testing
        case connected(ServerHealth)
        case failed(String)
    }

    @AppStorage(ServerSettings.key) private var serverText = ServerSettings.defaultURL
    @AppStorage(RoomPlanSettings.key) private var roomPlanEnabled = true
    @Environment(\.dismiss) private var dismiss
    @State private var test = ConnectionTest.idle

    private var serverURL: URL? { ServerSettings.normalized(serverText) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(ServerSettings.defaultURL, text: $serverText)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit(runTest)
                        .onChange(of: serverText) { if test != .testing { test = .idle } }
                    Button(action: runTest) {
                        HStack {
                            Label("Test connection", systemImage: "antenna.radiowaves.left.and.right")
                            Spacer()
                            if test == .testing { ProgressView() }
                        }
                    }
                    .disabled(serverURL == nil || test == .testing)
                    result
                } header: {
                    Text("Processing server")
                } footer: {
                    Text("Send to server uploads a capture here. The server trains the room and shows it in the web app. nook.salehtl.com is only reachable over Tailscale.")
                }
                if serverText != ServerSettings.defaultURL {
                    Section {
                        Button("Use \(ServerSettings.defaultURL)") { serverText = ServerSettings.defaultURL }
                    }
                }
                // RoomPlan needs LiDAR: phones without it never see the option (contract §4.12, I4).
                if RoomPlanSettings.isSupported {
                    Section {
                        Toggle("Measure the room shell", isOn: $roomPlanEnabled)
                    } header: {
                        Text("Scanning")
                    } footer: {
                        Text("After the photo passes, RoomPlan measures the walls, floor, doors and windows in about a minute. The planner shows them as a see-through shell. Skip it any time; the scan is kept either way.")
                    }
                }
                Section {
                    LabeledContent("Version", value: DeviceInfo.appVersion)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder private var result: some View {
        if serverURL == nil {
            Label(ServerError.invalidURL(serverText).localizedDescription, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .font(.footnote)
        }
        switch test {
        case .connected(let health):
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connected")
                    Text(summary(health)).font(.footnote).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            }
        case .failed(let message):
            Label {
                Text(message)
            } icon: {
                Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
            }
            .font(.footnote)
        case .idle, .testing:
            EmptyView()
        }
    }

    private func summary(_ h: ServerHealth) -> String {
        let load = h.busy ? "training now" : "idle"
        let queue = h.queued > 0 ? ", \(h.queued) queued" : ""
        let parts = [h.version.map { "nook-scan \($0)" }, h.trainer, h.gpu ?? "no GPU"].compactMap { $0 }
        return (parts + ["\(load)\(queue)"]).joined(separator: " · ")
    }

    private func runTest() {
        guard let url = serverURL, test != .testing else { return }
        test = .testing
        Task {
            do { test = .connected(try await ServerClient(base: url).health()) } catch { test = .failed(error.localizedDescription) }
        }
    }
}
