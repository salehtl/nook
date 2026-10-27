import SwiftUI

/// Shows the RoomPlan pass in place of `content` while it runs, then `content` again.
struct RoomPlanGate<Content: View>: View {
    @ObservedObject var pass: RoomPlanPass
    @ViewBuilder var content: Content

    var body: some View {
        if pass.phase.isActive {
            RoomPlanPassView(pass: pass)
        } else {
            content
        }
    }
}

/// The room-shell pass after the photo passes (contract §4.12): RoomPlan's camera view with its coaching in plain
/// words, a minute's timer and the walls found so far.
struct RoomPlanPassView: View {
    @ObservedObject var pass: RoomPlanPass

    var body: some View {
        ZStack {
            ARPreview(session: pass.arSession).ignoresSafeArea()
            VStack(spacing: 10) {
                if pass.phase == .scanning, let text = pass.instruction {
                    Label(text, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Color.orange.opacity(0.85), in: Capsule())
                        .foregroundStyle(.white)
                }
                Spacer()
                panel
            }
            .padding()
        }
        .background(Color.black)
        .preferredColorScheme(.dark)
    }

    @ViewBuilder private var panel: some View {
        VStack(alignment: .leading, spacing: 12) {
            if pass.phase == .building {
                ProgressView("Building the room shell…")
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                HStack {
                    Label("Room shell", systemImage: "cube.transparent")
                        .font(.headline)
                    Spacer()
                    Text(timeText)
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Text(Self.prompt)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ProgressView(value: min(1, pass.elapsed / RoomPlanPass.targetSeconds))
                    .tint(pass.elapsed >= RoomPlanPass.targetSeconds ? .green : nil)
                Text(pass.wallCount == 1 ? "1 wall found" : "\(pass.wallCount) walls found")
                    .font(.footnote.monospacedDigit())
                HStack(spacing: 10) {
                    Button {
                        pass.skip()
                    } label: {
                        Text("Skip").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button {
                        pass.finish()
                    } label: {
                        Label("Finish", systemImage: "checkmark").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(pass.wallCount == 0)
                }
                .controlSize(.large)
            }
        }
        .padding(16)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    /// SCANNING.md's room-shell step (ScanGuide.roomShell), minus its first sentence.
    static let prompt = ScanGuide.roomShell.lines.dropFirst().joined(separator: " ")

    private var timeText: String {
        let s = Int(pass.elapsed)
        return String(format: "%d:%02d / ~1:00", s / 60, s % 60)
    }
}

/// One line on the saved capture about its room shell.
struct RoomShellStatus: View {
    @ObservedObject var pass: RoomPlanPass

    var body: some View {
        switch pass.phase {
        case .saved(let walls, let matched):
            Label("Room shell: \(walls) walls, \(matched) lined up with the scan", systemImage: "cube.transparent")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .failed(let message):
            Label("No room shell: \(message)", systemImage: "cube.transparent")
                .font(.footnote)
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
        case .skipped:
            Label("Room shell skipped", systemImage: "cube.transparent")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .scanning, .building:
            EmptyView()
        }
    }
}
