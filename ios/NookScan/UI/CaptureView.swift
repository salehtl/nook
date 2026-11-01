import ARKit
import SwiftUI
import UIKit

/// The capture screen: live camera (or replay placeholder) with a Start step for the camera settings, exposure lock, frame
/// count, tracking banner, slow-down warning, Pause.
struct CaptureView: View {
    @ObservedObject var controller: CaptureController
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(ProcessingStore.self) private var processing
    @State private var confirmDiscard = false
    @State private var showCameraSettings = false

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
                if controller.phase == .recording, controller.isStarted {
                    HStack {
                        LockIndicator(state: controller.lockState, checking: controller.checkingFlicker)
                        Spacer()
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
            if controller.nearlyFull {
                Banner(text: "Scan nearly full: finish up", systemImage: "externaldrive.fill", color: .orange)
            } else if controller.lowStorage {
                Banner(text: "Low storage: this scan may not fit", systemImage: "externaldrive.fill", color: .orange)
            }
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
                if controller.isStarted { recordingControls } else { readyControls }
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
                    if let heights = summary.heightRange {
                        Text("Camera height \(heights.lowerBound, specifier: "%.1f")–\(heights.upperBound, specifier: "%.1f") m above the floor")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
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

    /// Before the scan: nothing is recorded yet, and the camera settings can still change.
    @ViewBuilder private var readyControls: some View {
        Text("Choose camera settings if you want to, then start and hold still for a moment.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        HStack(spacing: 10) {
            Button { controller.discard(); dismiss() } label: {
                Image(systemName: "xmark").frame(width: 20)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Cancel scan")
            Button { showCameraSettings = true } label: {
                Label("Camera", systemImage: "camera.aperture").lineLimit(1)
            }
            .buttonStyle(.bordered)
            Button { controller.begin() } label: {
                Text("Start").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .controlSize(.large)
        .sheet(isPresented: $showCameraSettings) {
            CameraSettingsView(isoRange: LiveCaptureSource.isoRange ?? 25...3200)
        }
    }

    @ViewBuilder private var recordingControls: some View {
        Text(statusText)
            .font(.subheadline.weight(.medium))
            .monospacedDigit()
            .frame(maxWidth: .infinity, alignment: .leading)
        if controller.isLive, !controller.interrupted, controller.lockState != .locking, !isSettling, !controller.checkingFlicker {
            Button { controller.togglePause() } label: {
                Label(controller.isPaused ? "Resume" : "Pause", systemImage: controller.isPaused ? "play.fill" : "pause.fill")
                    .font(.title3.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 48)
            }
            .buttonStyle(.borderedProminent)
            .tint(controller.isPaused ? .green : .orange)
        }
        HStack(spacing: 10) {
            Button(role: .destructive) {
                if controller.frameCount > 0 { confirmDiscard = true } else { controller.discard(); dismiss() }
            } label: {
                Image(systemName: "xmark").frame(width: 20)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Cancel scan")
            Button { controller.finish() } label: {
                Label("Done", systemImage: "checkmark").lineLimit(1).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(controller.frameCount == 0)
        }
        .controlSize(.large)
    }

    private var isSettling: Bool {
        if case .settling = controller.lockState { return true }
        return false
    }

    private var statusText: String {
        if controller.lockState == .locking || isSettling || controller.checkingFlicker { return "Hold still…" }
        let frames = "\(controller.frameCount) frames"
        return controller.isPaused ? "Paused · \(frames)" : frames
    }
}

/// Exposure and white-balance lock state, like the Camera app's AE/AF LOCK badge. Hidden for replay.
private struct LockIndicator: View {
    let state: ExposureLockPolicy.State
    /// The flicker check is running: the lock isn't final, so the phone should stay still.
    var checking = false

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

    private func shutterText(_ lock: CameraLock) -> String {
        guard let d = lock.exposureDuration, d > 0 else { return "exposure and white balance" }
        return "1/\(Int((1 / d).rounded())) s"
    }

    private var content: (String, String, Color)? {
        if checking { return ("Checking the light…", "lock.open", .white) }
        return switch state {
        case .settling, .locking:
            ("Locking exposure…", "lock.open", .white)
        case .locked(let lock) where lock.flickerDetected:
            ("LED flicker: using \(shutterText(lock))", "lightbulb.led", .yellow)
        case .locked(let lock) where lock.tooDark:
            ("Too dark for a fast shutter: turn on the lights", "lightbulb.slash", .orange)
        case .locked(let lock) where lock.isFullyLocked:
            ("Locked · \(shutterText(lock))", "lock.fill", .yellow)
        case .locked(let lock):
            (lock.exposureLocked ? "Exposure locked · WB auto" : "WB locked · exposure auto", "lock.trianglebadge.exclamationmark", .orange)
        case .unlockable:
            ("Auto exposure (couldn't lock)", "lock.slash", .orange)
        case .notApplicable:
            nil
        }
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
