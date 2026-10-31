import CoreVideo
import simd
import Testing
@testable import NookScan

/// Guided passes (contract §4.8 `pass`, §4.13): coverage per pass and the prompt for what to do next.
struct GuidedPassTests {
    private func yaw(sector i: Int) -> Float {
        (Float(i) + 0.5) / Float(PassCoverage.sectors) * 2 * .pi
    }

    private let level = Posture(pitchDegrees: 0)
    private let high = Posture(pitchDegrees: -40, relativeHeight: 0.3)
    private let low = Posture(pitchDegrees: 30, relativeHeight: -0.7)

    @Test func passesRunInOrderAndStayWithinTheContract() {
        #expect(ScanPass.allCases.map(\.rawValue) == [1, 2, 3, 4])
        #expect(ScanPass.standard.next == .giant)
        #expect(ScanPass.giant.next == .ant)
        #expect(ScanPass.ant.next == .testWalk)
        #expect(ScanPass.testWalk.next == nil)
        #expect(ScanPass.allCases.map(\.contractNumber) == [1, 2, 3, 3], "a frame's pass is 1, 2 or 3 (§4.8)")
    }

    @Test func headingsMapToTwelveSectors() {
        #expect(PassCoverage.sector(yaw: 0) == 0)
        #expect(PassCoverage.sector(yaw: .pi) == 6)
        #expect(PassCoverage.sector(yaw: 2 * .pi - 0.001) == 11)
        #expect(PassCoverage.sector(yaw: 2 * .pi) == 0, "a full turn wraps around")
    }

    @Test func coverageIsTrackedPerPass() {
        var guide = PassGuide()
        for i in 0..<10 { guide.add(yaw: yaw(sector: i), posture: level) }
        #expect(guide.current.count == 10)
        #expect(guide.current.isGood)
        let advanced = guide.advance()
        #expect(advanced)
        #expect(guide.pass == .giant)
        #expect(guide.current.count == 0, "the second pass starts with its own coverage")
        #expect(guide.coverage[0].count == 10)
    }

    @Test func highLoopNeedsTheRightHeightAndTilt() {
        var guide = PassGuide(pass: .giant)
        let tiltedAtChestHeight = guide.add(yaw: yaw(sector: 0), posture: Posture(pitchDegrees: -40, relativeHeight: 0))
        let highButLevel = guide.add(yaw: yaw(sector: 0), posture: Posture(pitchDegrees: 0, relativeHeight: 0.3))
        let right = guide.add(yaw: yaw(sector: 0), posture: high)
        let again = guide.add(yaw: yaw(sector: 0), posture: high)
        #expect(!tiltedAtChestHeight, "the phone must really go up: last scans only tilted")
        #expect(!highButLevel)
        #expect(right)
        #expect(!again, "a sector lights once")
    }

    @Test func lowLoopNeedsTheRightHeightAndTilt() {
        var guide = PassGuide(pass: .ant)
        let tiltedAtChestHeight = guide.add(yaw: yaw(sector: 0), posture: Posture(pitchDegrees: 30, relativeHeight: 0))
        let lowButLevel = guide.add(yaw: yaw(sector: 0), posture: Posture(pitchDegrees: 0, relativeHeight: -0.7))
        let straightUp = guide.add(yaw: yaw(sector: 0), posture: Posture(pitchDegrees: 80, relativeHeight: -0.7))
        let right = guide.add(yaw: yaw(sector: 0), posture: low)
        #expect(!tiltedAtChestHeight)
        #expect(!lowButLevel)
        #expect(!straightUp, "straight up is plain ceiling, which tracking can lose")
        #expect(right)
    }

    @Test func unknownHeightDoesNotBlockCoverage() {
        var guide = PassGuide(pass: .giant)
        let counted = guide.add(yaw: yaw(sector: 0), posture: Posture(pitchDegrees: -40))
        #expect(counted, "a capture that skipped the first loop has no reference")
    }

    @Test func postureHints() {
        #expect(ScanPass.standard.postureHint(Posture(pitchDegrees: -60)) != nil)
        #expect(ScanPass.standard.postureHint(Posture(pitchDegrees: -10)) == nil)
        #expect(ScanPass.giant.postureHint(Posture(pitchDegrees: -40, relativeHeight: 0)) == "Raise the phone above head height")
        #expect(ScanPass.giant.postureHint(Posture(pitchDegrees: 0, relativeHeight: 0.4)) == "Tilt the phone down toward the floor")
        #expect(ScanPass.giant.postureHint(high) == nil)
        #expect(ScanPass.ant.postureHint(Posture(pitchDegrees: 30, relativeHeight: 0)) == "Lower the phone to knee height")
        #expect(ScanPass.ant.postureHint(Posture(pitchDegrees: 0, relativeHeight: -0.7)) == "Tilt the phone up toward the walls")
        #expect(ScanPass.ant.postureHint(Posture(pitchDegrees: 80, relativeHeight: -0.7)) == "Tilt down a little: keep walls in view")
        #expect(ScanPass.ant.postureHint(low) == nil)
        #expect(ScanPass.testWalk.postureHint(Posture(pitchDegrees: 80, relativeHeight: -1)) == nil)
    }

    @Test func heightIsJudgedAgainstTheFirstLoop() {
        var reference = HeightReference()
        #expect(reference.relative(1) == nil, "no reference yet")
        for _ in 0..<HeightReference.minSamples { reference.add(-0.1) }
        #expect(abs((reference.relative(0.3) ?? 0) - 0.4) < 1e-5)
    }

    @Test func promptSaysWhatToDoNext() {
        var guide = PassGuide()
        #expect(guide.prompt == ScanPass.standard.instruction)
        guide.add(yaw: yaw(sector: 0), posture: level)
        #expect(guide.prompt.hasSuffix("1/10 directions so far."))
        for i in 1..<10 { guide.add(yaw: yaw(sector: i), posture: level) }
        #expect(guide.prompt.contains("Tap Next pass"))
        #expect(guide.prompt.contains("above head height"))

        guide.advance()
        #expect(guide.prompt == ScanPass.giant.instruction)
        for i in 0..<10 { guide.add(yaw: yaw(sector: i), posture: high) }
        #expect(guide.prompt.contains("knee height"))

        guide.advance()
        for i in 0..<10 { guide.add(yaw: yaw(sector: i), posture: low) }
        #expect(guide.prompt.contains("Tap Test walk"))

        guide.advance()
        for i in 0..<6 { guide.add(yaw: yaw(sector: i), posture: level) }
        #expect(guide.prompt.contains("Tap Done"))
        let fifth = guide.advance()
        #expect(!fifth, "the test walk is the last pass")
        #expect(guide.pass == .testWalk)
    }

    @Test func finishingAsksAboutWhatsMissing() {
        var guide = PassGuide()
        #expect(guide.missing == [.standard, .giant, .ant, .testWalk])
        for i in 0..<10 { guide.add(yaw: yaw(sector: i), posture: level) }
        #expect(guide.missing == [.giant, .ant, .testWalk])
    }

    @Test func pitchFromCameraPose() {
        // ARKit camera looks along −Z. Identity looks level; rotating about +X by −30° looks 30° down.
        #expect(abs(Pose.pitchDegrees(matrix_identity_float4x4)) < 1e-4)
        let down = simd_float4x4(simd_quatf(angle: -.pi / 6, axis: SIMD3(1, 0, 0)))
        #expect(abs(Pose.pitchDegrees(down) + 30) < 1e-3)
    }

    @Test func seedGridKeepsOnePointPerCell() {
        var grid = SeedGrid(cellSize: 0.025)
        let first = grid.insert(x: 1.01, y: -1.01, z: 0.51)
        let sameSpot = grid.insert(x: 1.011, y: -1.011, z: 0.511)
        let elsewhere = grid.insert(x: 1.11, y: -1.01, z: 0.51)
        let negative = grid.insert(x: -1.01, y: -1.01, z: 0.51)
        #expect(first)
        #expect(!sameSpot, "the same spot seen again adds nothing")
        #expect(elsewhere)
        #expect(negative, "negative coordinates get their own cells")
        #expect(grid.count == 3)
    }

    /// A still (§4.10) is stored at most 2880 px with matching intrinsics, test-walk frames are flagged, and the
    /// ending is recorded (§4.13). Every size and key is read back from what was written.
    @Test func writerRecordsStillsTestWalkAndEnding() throws {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("writer-v14-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: out) }
        let writer = try CaptureWriter(folder: out, info: CaptureInfo(device: "test", lidar: false))
        var buffer: CVPixelBuffer?
        let attrs = [kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()] as CFDictionary
        #expect(CVPixelBufferCreate(nil, 4032, 3024, kCVPixelFormatType_32BGRA, attrs, &buffer) == kCVReturnSuccess)
        let pb = try #require(buffer)
        let full = Intrinsics(fx: 2856, fy: 2856, cx: 2016, cy: 1512, width: 4032, height: 3024)
        var kf = Keyframe(timestamp: 1, transform: matrix_identity_float4x4, intrinsics: full, image: .pixelBuffer(pb), depth: nil)
        kf.still = Still(image: pb, intrinsics: full)
        kf.pass = .ant
        writer.append(kf, index: 1, time: 0)
        var walk = Keyframe(timestamp: 2, transform: matrix_identity_float4x4, intrinsics: full, image: .pixelBuffer(pb), depth: nil)
        walk.pass = .testWalk
        writer.append(walk, index: 2, time: 1)
        _ = try writer.finish(floorY: nil, ending: .failed("ARKit stopped"))

        let transforms = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: out.appendingPathComponent("transforms.json"))) as? [String: Any])
        let frames = try #require(transforms["frames"] as? [[String: Any]])
        #expect(frames[0]["pass"] as? Int == 3)
        #expect(frames[0].keys.contains("test_walk") == false)
        #expect(frames[1]["pass"] as? Int == 3)
        #expect(frames[1]["test_walk"] as? Bool == true)
        #expect(frames[0]["hires_w"] as? Int == 2880)
        #expect(frames[0]["hires_h"] as? Int == 2160)
        #expect(abs((frames[0]["hires_fl_x"] as? Double ?? 0) - 2040) < 1e-6)
        #expect(abs((frames[0]["hires_cx"] as? Double ?? 0) - 1440) < 1e-6)
        let jpeg = try #require(ImageUtils.loadImage(out.appendingPathComponent("images_hi/000001.jpg")))
        #expect(jpeg.width == 2880, "the file is exactly the size transforms.json states")
        #expect(jpeg.height == 2160, "the file is exactly the size transforms.json states")

        let meta = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: out.appendingPathComponent("meta.json"))) as? [String: Any])
        #expect(meta["end_reason"] as? String == "failed")
        #expect(meta["end_message"] as? String == "ARKit stopped")
        #expect(meta["thermal_state"] as? String != nil)
    }
}
