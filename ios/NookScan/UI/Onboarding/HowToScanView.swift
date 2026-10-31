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
            .aspectRatio(1.7, contentMode: .fit)
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
    /// Room for the page dots, which float over the pages, so they never sit on the text.
    private static let pageDotsHeight: CGFloat = 44

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TabView(selection: $page) {
                    ForEach(Array(guides.enumerated()), id: \.element) { i, guide in
                        ScrollView { GuideCard(guide: guide, guides: guides) }
                            .safeAreaPadding(.bottom, Self.pageDotsHeight)
                            .tag(i)
                    }
                    ScrollView { DoDontView() }
                        .safeAreaPadding(.bottom, Self.pageDotsHeight)
                        .tag(guides.count)
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
