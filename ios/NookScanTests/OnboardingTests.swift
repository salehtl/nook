import SwiftUI
import XCTest
@testable import NookScan

/// Snapshot-style checks of the scanning guides: each renders a non-empty image at phone size, the animation
/// actually moves, the text is SCANNING.md's, and the first-run flag works.
@MainActor
final class OnboardingTests: XCTestCase {
    static let phone = CGSize(width: 393, height: 760)

    private func render<V: View>(_ view: V, size: CGSize = OnboardingTests.phone) throws -> CGImage {
        let renderer = ImageRenderer(content: view.frame(width: size.width, height: size.height).background(Color.white))
        renderer.scale = 2
        return try XCTUnwrap(renderer.cgImage, "ImageRenderer produced no image")
    }

    /// RGBA bytes of an image.
    private func pixels(_ image: CGImage) throws -> [UInt8] {
        var data = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let ctx = try XCTUnwrap(CGContext(data: &data, width: image.width, height: image.height, bitsPerComponent: 8,
                                          bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return data
    }

    /// Fraction of pixels that aren't the background (white).
    private func inkFraction(_ image: CGImage) throws -> Double {
        let p = try pixels(image)
        var ink = 0
        for i in stride(from: 0, to: p.count, by: 4) where Int(p[i]) + Int(p[i + 1]) + Int(p[i + 2]) < 750 { ink += 1 }
        return Double(ink) / Double(image.width * image.height)
    }

    func testEveryGuideRendersAtPhoneSize() throws {
        for guide in ScanGuide.allCases {
            let image = try render(GuideCard(guide: guide, time: 1.7))
            XCTAssertEqual(image.width, Int(Self.phone.width * 2), "\(guide)")
            XCTAssertEqual(image.height, Int(Self.phone.height * 2), "\(guide)")
            let ink = try inkFraction(image)
            XCTAssertGreaterThan(ink, 0.02, "\(guide) rendered nearly blank (\(ink))")
        }
        let cards = try render(DoDontView())
        XCTAssertGreaterThan(try inkFraction(cards), 0.02, "do/don't cards rendered nearly blank")
    }

    func testGuideAnimationsMove() throws {
        for guide in ScanGuide.allCases {
            let size = CGSize(width: 360, height: 270)
            let a = try pixels(render(GuideScene(guide: guide, time: 0.5), size: size))
            let b = try pixels(render(GuideScene(guide: guide, time: 3.9), size: size))
            XCTAssertNotEqual(a, b, "\(guide): the animation should change over its loop")
            let looped = try pixels(render(GuideScene(guide: guide, time: 0.5 + GuideScene.period), size: size))
            XCTAssertEqual(a, looped, "\(guide): one period later it should be back where it started")
        }
    }

    func testPassStripRenders() throws {
        for pass in ScanPass.allCases {
            let image = try render(PassStrip(pass: pass, animated: false), size: CGSize(width: 361, height: 60))
            XCTAssertGreaterThan(try inkFraction(image), 0.2, "\(pass) strip")
        }
        XCTAssertEqual(ScanPass.allCases.map(ScanGuide.forPass), [.pass1, .pass2, .pass3])
    }

    func testFirstRunFlag() throws {
        let suite = "nook-onboarding-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertTrue(OnboardingState.needsFirstRun(defaults), "a fresh install shows the guide")
        OnboardingState.markSeen(defaults)
        XCTAssertFalse(OnboardingState.needsFirstRun(defaults), "once seen, only How to scan shows it")
        XCTAssertTrue(OnboardingState.isRunningTests, "the first-run sheet stays away from the test host")
    }

    /// Every sentence the guides show is in docs/SCANNING.md (with its **bold** markers removed).
    func testTextMatchesTheScanningGuide() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "SCANNING", withExtension: "md"))
        let doc = try String(contentsOf: url, encoding: .utf8).replacingOccurrences(of: "**", with: "")
        for guide in ScanGuide.allCases {
            for line in guide.lines {
                XCTAssertTrue(doc.contains(line), "\(guide): not in SCANNING.md: \(line)")
            }
        }
        for card in ScanGuide.cards {
            XCTAssertTrue(doc.contains(card.source), "card \(card.heading): not in SCANNING.md: \(card.source)")
        }
        XCTAssertEqual(ScanGuide.allCases.count, 6)
        XCTAssertEqual(ScanGuide.visible(lidar: true), ScanGuide.allCases)
        XCTAssertEqual(ScanGuide.visible(lidar: false), [.prepare, .lockLight, .pass1, .pass2, .pass3],
                       "phones without LiDAR never see the room-shell guide")
        XCTAssertTrue(doc.contains(RoomPlanPassView.prompt), "the RoomPlan pass prompt is SCANNING.md's")
        XCTAssertEqual(Set(ScanGuide.cards.map(\.isDo)), [true, false], "both do and don't cards")
    }
}
