import simd
import XCTest
@testable import NookScan

final class KeyframeSelectorTests: XCTestCase {
    private func pose(x: Float = 0, yawDegrees: Float = 0) -> simd_float4x4 {
        var m = simd_float4x4(simd_quatf(angle: yawDegrees * .pi / 180, axis: SIMD3(0, 1, 0)))
        m.columns.3 = SIMD4(x, 0, 0, 1)
        return m
    }

    /// Runs evaluate and commits on keep, like CaptureRecorder.
    private func feed(_ s: inout KeyframeSelector, _ m: simd_float4x4, tracking: TrackingStatus = .normal, sharpness: Float = 100) -> FrameDecision {
        let d = s.evaluate(transform: m, tracking: tracking, sharpness: { sharpness })
        if d == .keep { s.commit(transform: m) }
        return d
    }

    func testMovementThresholds() {
        var s = KeyframeSelector()
        XCTAssertEqual(feed(&s, pose()), .keep, "the first sharp, tracked frame is kept")
        XCTAssertEqual(feed(&s, pose(x: 0.05)), .notMoved)
        XCTAssertEqual(feed(&s, pose(x: 0.079)), .notMoved)
        XCTAssertEqual(feed(&s, pose(x: 0.081)), .keep, "moved ≥ 8 cm")
        XCTAssertEqual(feed(&s, pose(x: 0.081, yawDegrees: 5)), .notMoved)
        XCTAssertEqual(feed(&s, pose(x: 0.081, yawDegrees: 6.1)), .keep, "turned ≥ 6°")
    }

    func testTrackingMustBeNormal() {
        var s = KeyframeSelector()
        XCTAssertEqual(feed(&s, pose(), tracking: .limited("Starting up")), .trackingLimited)
        XCTAssertEqual(feed(&s, pose(), tracking: .notAvailable), .trackingLimited)
        XCTAssertEqual(feed(&s, pose()), .keep)
    }

    func testBlurryFramesAreRejected() {
        var s = KeyframeSelector()
        for i in 0..<10 { XCTAssertEqual(feed(&s, pose(x: Float(i) * 0.1), sharpness: 120), .keep) }
        XCTAssertEqual(feed(&s, pose(x: 2), sharpness: 20), .blurry, "much less sharp than recent frames")
        XCTAssertEqual(feed(&s, pose(x: 2), sharpness: 1), .blurry, "below the absolute floor")
        XCTAssertEqual(feed(&s, pose(x: 2), sharpness: 90), .keep)
    }

    func testLowTextureScenesAreNotStuck() {
        // A plain wall: every frame scores low. The relative threshold adapts instead of rejecting forever.
        var s = KeyframeSelector()
        _ = feed(&s, pose(), sharpness: 300)
        var kept = 0
        for i in 1...40 where feed(&s, pose(x: Float(i) * 0.1), sharpness: 15) == .keep { kept += 1 }
        XCTAssertGreaterThan(kept, 20)
    }

    func testFloorIsLowestLargeHorizontalPlane() {
        XCTAssertNil(FloorEstimator.floorY(planes: []))
        XCTAssertNil(FloorEstimator.floorY(planes: [(y: -1.3, area: 0.5)]))
        XCTAssertEqual(FloorEstimator.floorY(planes: [(y: -0.6, area: 2), (y: -1.32, area: 3.5), (y: -1.6, area: 0.2), (y: 1.1, area: 6)]), -1.32)
    }

    func testMotionMonitorFlagsFastMovement() {
        var slow = MotionMonitor(), fast = MotionMonitor()
        for i in 0..<60 {
            let t = Double(i) / 60
            slow.update(timestamp: t, transform: pose(x: Float(t) * 0.2))
            fast.update(timestamp: t, transform: pose(yawDegrees: Float(t) * 180))
        }
        XCTAssertFalse(slow.isTooFast)
        XCTAssertTrue(fast.isTooFast)
    }

    func testIntrinsicsScaling() {
        let k = Intrinsics(fx: 1440, fy: 1440, cx: 960, cy: 720, width: 1920, height: 1440)
        let d = k.scaled(toWidth: 256, height: 192)
        XCTAssertEqual(d.fx, 192, accuracy: 1e-9)
        XCTAssertEqual(d.cx, 128, accuracy: 1e-9)
        XCTAssertEqual(d.cy, 96, accuracy: 1e-9)
    }
}
