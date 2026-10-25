import ARKit
import SwiftUI
import UIKit

/// The capture screen: live camera (or replay placeholder) with guidance: frame counter, tracking banner,
/// slow-down warning and a coverage ring.
struct CaptureView: View {
    @ObservedObject var controller: CaptureController
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var confirmDiscard = false

    var body: some View {
        ZStack {
            preview.ignoresSafeArea()
            VStack(spacing: 10) {
                banners
                Spacer()
                bottomPanel
            }
            .padding()
        }
        .background(Color.black)
        .preferredColorScheme(.dark)
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
            controller.start()
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            if controller.phase == .recording { controller.discard() }
        }
        .confirmationDialog("Discard this capture?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) {
                controller.discard()
                dismiss()
            }
        }
    }

    @ViewBuilder private var preview: some View {
        if let live = controller.source as? LiveCaptureSource {
            ARPreview(session: live.session)
        } else {
            VStack(spacing: 12) {
                Image(systemName: "arrow.triangle.2.circlepath.camera")
                    .font(.system(size: 56, weight: .light))
                Text(controller.phase == .recording ? "Replaying sample capture" : "Replay finished")
                    .font(.headline)
                if let p = controller.progress, controller.phase == .recording {
                    ProgressView(value: p).frame(width: 200)
                }
            }
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(white: 0.08))
        }
    }

    @ViewBuilder private var banners: some View {
        if controller.phase == .recording && controller.interrupted {
            Banner(text: "Scan interrupted. Tap Done to save what you have, then start a new scan for the rest.",
                   systemImage: "pause.circle.fill", color: .orange)
        } else if controller.phase == .recording {
            if let message = controller.tracking.message {
                Banner(text: message, systemImage: "exclamationmark.triangle.fill", color: .orange)
            }
            if controller.tooFast {
                Banner(text: "Slow down for sharp frames", systemImage: "tortoise.fill", color: .red)
            }
        }
    }

    @ViewBuilder private var bottomPanel: some View {
        VStack(spacing: 14) {
            switch controller.phase {
            case .recording:
                HStack(alignment: .center, spacing: 18) {
                    CoverageRing(coverage: controller.coverage)
                        .frame(width: 54, height: 54)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(controller.frameCount)")
                            .font(.system(size: 40, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                        Text(controller.frameCount < CaptureController.minFrames
                             ? "frames · need at least \(CaptureController.minFrames)" : "frames")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                Text(coverageHint)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack {
                    Button(role: .destructive) {
                        if controller.frameCount > 0 { confirmDiscard = true } else { controller.discard(); dismiss() }
                    } label: {
                        Label("Cancel", systemImage: "xmark").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button {
                        controller.finish()
                    } label: {
                        Label("Done", systemImage: "checkmark").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(controller.frameCount == 0)
                }
                .controlSize(.large)
            case .saving:
                ProgressView("Saving capture…")
                    .frame(maxWidth: .infinity, minHeight: 80)
            case .saved(let summary):
                VStack(alignment: .leading, spacing: 6) {
                    Label("Saved \(summary.folder.lastPathComponent)", systemImage: "checkmark.circle.fill")
                        .font(.headline)
                    Text("\(summary.frameCount) frames · \(summary.depthCount) depth maps · \(summary.pointCount) seed points")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if summary.frameCount < CaptureController.minFrames {
                        Text("Too few frames for training (need \(CaptureController.minFrames)).")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button("Close") { dismiss() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .frame(maxWidth: .infinity)
            case .failed(let message):
                Label(message, systemImage: "xmark.octagon.fill")
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack {
                    if controller.needsSettings, let url = URL(string: UIApplication.openSettingsURLString) {
                        Button("Open Settings") { openURL(url) }
                            .buttonStyle(.borderedProminent)
                    }
                    Button("Close") { dismiss() }
                        .buttonStyle(.bordered)
                }
                .controlSize(.large)
            }
        }
        .padding(16)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var coverageHint: String {
        let n = controller.coveredSectors
        if controller.frameCount == 0 { return "Move slowly. Frames are kept every 8 cm or 6°." }
        if n < CaptureController.sectors * 2 / 3 { return "Turn to cover the rest of the room (\(n)/\(CaptureController.sectors) directions)." }
        return "Good coverage. Add a second pass at a different height."
    }
}

private struct Banner: View {
    let text: String
    let systemImage: String
    let color: Color

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(color.opacity(0.85), in: Capsule())
            .foregroundStyle(.white)
            .transition(.move(edge: .top).combined(with: .opacity))
    }
}

/// Twelve segments, one per 30° of heading, lit once a keyframe looked that way.
private struct CoverageRing: View {
    let coverage: [Bool]

    var body: some View {
        let n = coverage.count
        ZStack {
            ForEach(0..<n, id: \.self) { i in
                Circle()
                    .trim(from: CGFloat(i) / CGFloat(n) + 0.008, to: CGFloat(i + 1) / CGFloat(n) - 0.008)
                    .stroke(coverage[i] ? Color.green : Color.white.opacity(0.2), style: StrokeStyle(lineWidth: 7, lineCap: .butt))
                    .rotationEffect(.degrees(-90))
            }
        }
        .accessibilityLabel("Coverage \(coverage.filter { $0 }.count) of \(n) directions")
    }
}

/// Camera feed for the live ARSession, with feature points so you can see tracking working.
struct ARPreview: UIViewRepresentable {
    let session: ARSession

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.session = session
        view.scene = SCNScene()
        view.automaticallyUpdatesLighting = false
        view.debugOptions = [.showFeaturePoints]
        return view
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}
