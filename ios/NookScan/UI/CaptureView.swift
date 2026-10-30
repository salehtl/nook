import ARKit
import SwiftUI
import UIKit

/// The capture screen: live camera (or replay placeholder) with guidance: exposure lock indicator, frame
/// counter, tracking banner, slow-down warning, and the three guided passes with a coverage ring for each.
struct CaptureView: View {
    @ObservedObject var controller: CaptureController
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(ProcessingStore.self) private var processing
    @State private var confirmDiscard = false

    var body: some View {
        Group {
            if let pass = controller.roomPlan {
                RoomPlanGate(pass: pass) { captureScreen }
            } else {
                captureScreen
            }
        }
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
            controller.start()
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            controller.roomPlan?.skip()
            if controller.phase == .recording { controller.discard() }
        }
        .confirmationDialog("Discard this capture?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) {
                controller.discard()
                dismiss()
            }
        }
    }

    private var captureScreen: some View {
        ZStack {
            preview.ignoresSafeArea()
            VStack(spacing: 10) {
                if controller.phase == .recording {
                    HStack {
                        LockIndicator(state: controller.lockState)
                        Spacer()
                    }
                    if controller.lockState != .locking, !isSettling {
                        PassStrip(pass: controller.guide.pass)
                    }
                }
                banners
                Spacer()
                bottomPanel
            }
            .padding()
        }
        .background(Color.black)
        .preferredColorScheme(.dark)
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
            } else if let hint = controller.postureHint, controller.lockState != .locking {
                Banner(text: hint, systemImage: "iphone.gen3", color: .blue)
            }
        }
    }

    @ViewBuilder private var bottomPanel: some View {
        VStack(spacing: 14) {
            switch controller.phase {
            case .recording:
                HStack(alignment: .center, spacing: 18) {
                    CoverageRing(coverage: controller.guide.current.lit)
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
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        PassSteps(guide: controller.guide)
                        Text(controller.guide.pass.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    Text(promptText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 10) {
                    Button(role: .destructive) {
                        if controller.frameCount > 0 { confirmDiscard = true } else { controller.discard(); dismiss() }
                    } label: {
                        Image(systemName: "xmark").frame(width: 20)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Cancel scan")
                    if controller.guide.pass.next != nil {
                        Button {
                            controller.nextPass()
                        } label: {
                            Text("Next pass").lineLimit(1).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .tint(controller.guide.current.isGood ? .green : nil)
                        .disabled(controller.frameCount == 0)
                    }
                    Button {
                        controller.finish()
                    } label: {
                        Label("Done", systemImage: "checkmark").lineLimit(1).frame(maxWidth: .infinity)
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
                    if let pass = controller.roomPlan {
                        RoomShellStatus(pass: pass)
                    }
                    if summary.frameCount < CaptureController.minFrames {
                        Text("Too few frames for training (need \(CaptureController.minFrames)).")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 10) {
                    if summary.frameCount >= CaptureController.minFrames {
                        Button("Close") { dismiss() }
                            .buttonStyle(.bordered)
                        Button {
                            processing.send(folder: summary.folder, to: ServerSettings.current)
                            dismiss()
                        } label: {
                            Label("Send to server", systemImage: "paperplane.fill").lineLimit(1).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                    } else {
                        Button {
                            dismiss()
                        } label: {
                            Text("Close").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
                .controlSize(.large)
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

    private var isSettling: Bool {
        if case .settling = controller.lockState { return true }
        return false
    }

    private var promptText: String {
        switch controller.lockState {
        case .settling, .locking:
            return "Point the phone at the room and hold steady for a second while exposure and white balance lock."
        default:
            return controller.frameCount == 0
                ? "\(controller.guide.pass.instruction) Move slowly: frames are kept every 8 cm or 6°."
                : controller.guide.prompt
        }
    }
}

/// Exposure and white-balance lock state, like the Camera app's AE/AF LOCK badge. Hidden for replay.
private struct LockIndicator: View {
    let state: ExposureLockPolicy.State

    var body: some View {
        if let (text, icon, color) = content {
            Label(text, systemImage: icon)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(.black.opacity(0.55), in: Capsule())
                .foregroundStyle(color)
                .accessibilityElement(children: .combine)
        }
    }

    private var content: (String, String, Color)? {
        switch state {
        case .settling, .locking:
            ("Locking exposure…", "lock.open", .white)
        case .locked(let lock) where lock.tooDark:
            ("Too dark for a fast shutter: turn on the lights", "lightbulb.slash", .orange)
        case .locked(let lock) where lock.isFullyLocked:
            (lock.exposureDuration.map { "Locked · 1/\(Int(($0 > 0 ? 1 / $0 : 0).rounded())) s" } ?? "Exposure + WB locked", "lock.fill", .yellow)
        case .locked(let lock):
            (lock.exposureLocked ? "Exposure locked · WB auto" : "WB locked · exposure auto", "lock.trianglebadge.exclamationmark", .orange)
        case .unlockable:
            ("Auto exposure (couldn't lock)", "lock.slash", .orange)
        case .notApplicable:
            nil
        }
    }
}

/// Three numbered dots for the guided passes: done passes filled (green when their coverage was good), the current
/// one outlined.
private struct PassSteps: View {
    let guide: PassGuide

    var body: some View {
        HStack(spacing: 4) {
            ForEach(ScanPass.allCases, id: \.rawValue) { pass in
                let done = pass.rawValue < guide.pass.rawValue
                let good = guide.coverage[pass.rawValue - 1].isGood
                ZStack {
                    Circle()
                        .fill(done ? (good ? Color.green : Color.white.opacity(0.35)) : Color.clear)
                    Circle()
                        .strokeBorder(pass == guide.pass ? Color.white : Color.white.opacity(0.3), lineWidth: 2)
                    if done && good {
                        Image(systemName: "checkmark").font(.system(size: 10, weight: .bold))
                    } else {
                        Text("\(pass.rawValue)").font(.caption2.weight(.semibold))
                    }
                }
                .frame(width: 22, height: 22)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Pass \(guide.pass.rawValue) of \(ScanPass.allCases.count)")
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
