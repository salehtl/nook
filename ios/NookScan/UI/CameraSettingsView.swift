import SwiftUI

/// Shutter, ISO and stills, chosen before a scan starts (contract §4.14). Auto covers nearly every room.
struct CameraSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var settings = CameraSettings.current
    let isoRange: ClosedRange<Double>

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Shutter", selection: $settings.shutterDenominator) {
                        ForEach(CameraSettings.shutterChoices, id: \.self) { d in
                            Text(d == 0 ? "Auto" : "1/\(d) s").tag(d)
                        }
                    }
                } footer: {
                    Text("Auto picks the fastest shutter the light allows, and moves to 1/100 s or 1/120 s if it detects LED flicker. On 60 Hz mains it can miss flicker, so choose 1/120 s yourself. Slower blurs more when you move.")
                }
                Section {
                    Toggle("Match brightness", isOn: Binding(
                        get: { settings.iso == nil },
                        set: { settings.iso = $0 ? nil : min(max(400, isoRange.lowerBound), isoRange.upperBound) }))
                    if let iso = settings.iso {
                        VStack(alignment: .leading) {
                            Text("ISO \(Int(iso))").monospacedDigit()
                            Slider(value: Binding(get: { iso }, set: { settings.iso = $0.rounded() }), in: isoRange)
                        }
                    }
                } footer: {
                    Text("Higher ISO keeps the picture bright at a fast shutter, with more noise.")
                }
                Section {
                    Toggle("High-resolution photos", isOn: $settings.takeStills)
                } footer: {
                    Text("Turn this off if you still hear a shutter click: the scan then uses video frames only.")
                }
                if settings != CameraSettings() {
                    Section {
                        Button("Back to Auto") { settings = CameraSettings() }
                    }
                }
            }
            .navigationTitle("Camera")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onChange(of: settings) { CameraSettings.current = settings }
        }
    }
}
