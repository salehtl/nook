import SwiftUI

/// One guide: its animation, title and the SCANNING.md text. `time` fixes the frame (tests); nil loops it.
struct GuideCard: View {
    let guide: ScanGuide
    var time: Double?
    /// The guides shown on this phone, for "Step n of m".
    var guides = ScanGuide.visible()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Group {
                if let time {
                    GuideScene(guide: guide, time: time)
                } else {
                    LoopingGuideScene(guide: guide)
                }
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(1.35, contentMode: .fit)
            .padding(8)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            Text("Step \((guides.firstIndex(of: guide) ?? guide.rawValue) + 1) of \(guides.count)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Label(guide.title, systemImage: guide.systemImage)
                .font(.title2.weight(.semibold))
            ForEach(guide.lines, id: \.self) { line in
                Text(line)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(20)
    }
}

/// Do and don't cards.
struct DoDontView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Do and don't", systemImage: "checklist")
                .font(.title2.weight(.semibold))
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(ScanGuide.cards) { card in
                    VStack(alignment: .leading, spacing: 6) {
                        Label(card.heading, systemImage: card.isDo ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(card.isDo ? Color.green : Color.red)
                        Text(card.source)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, minHeight: 110, alignment: .topLeading)
                    .background((card.isDo ? Color.green : Color.red).opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(20)
    }
}

/// How to scan: the guides and the do/don't cards, paged. The first-run sheet and the How to scan button.
struct HowToScanView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var page = 0
    /// The room-shell guide only on phones with LiDAR (RoomPlan).
    private let guides = ScanGuide.visible()
    private var pages: Int { guides.count + 1 }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TabView(selection: $page) {
                    ForEach(Array(guides.enumerated()), id: \.element) { i, guide in
                        ScrollView { GuideCard(guide: guide, guides: guides) }.tag(i)
                    }
                    ScrollView { DoDontView() }.tag(guides.count)
                }
                .tabViewStyle(.page(indexDisplayMode: .always))
                .indexViewStyle(.page(backgroundDisplayMode: .always))
                Button {
                    if page < pages - 1 { withAnimation { page += 1 } } else { dismiss() }
                } label: {
                    Text(page < pages - 1 ? "Next" : "Got it").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding()
            }
            .navigationTitle("How to scan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// The slim strip during capture: the current pass's animation and its one line. Tap to hide or show.
struct PassStrip: View {
    let pass: ScanPass
    @AppStorage("passStripVisible") private var visible = true
    var animated = true

    var body: some View {
        let guide = ScanGuide.forPass(pass)
        Button {
            withAnimation(.snappy) { visible.toggle() }
        } label: {
            HStack(spacing: 10) {
                if visible {
                    Group {
                        if animated { LoopingGuideScene(guide: guide, compact: true) } else { GuideScene(guide: guide, time: 2, compact: true) }
                    }
                    .frame(width: 54, height: 44)
                    Text(guide.lines[0])
                        .font(.caption)
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Image(systemName: "questionmark.circle")
                    Text("How to").font(.caption.weight(.semibold))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(visible ? "\(guide.title). Hide tip" : "Show tip")
    }
}
