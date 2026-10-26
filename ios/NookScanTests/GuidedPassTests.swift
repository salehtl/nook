import simd
import Testing
@testable import NookScan

/// Guided passes (contract §4.8 `pass`): coverage per pass and the prompt for what to do next.
struct GuidedPassTests {
    private func yaw(sector i: Int) -> Float {
        (Float(i) + 0.5) / Float(PassCoverage.sectors) * 2 * .pi
    }

    @Test func passNumbersMatchTheContract() {
        #expect(ScanPass.allCases.map(\.rawValue) == [1, 2, 3])
        #expect(ScanPass.chest.next == .low)
        #expect(ScanPass.low.next == .middle)
        #expect(ScanPass.middle.next == nil)
    }

    @Test func headingsMapToTwelveSectors() {
        #expect(PassCoverage.sector(yaw: 0) == 0)
        #expect(PassCoverage.sector(yaw: .pi) == 6)
        #expect(PassCoverage.sector(yaw: 2 * .pi - 0.001) == 11)
        #expect(PassCoverage.sector(yaw: 2 * .pi) == 0, "a full turn wraps around")
    }

    @Test func coverageIsTrackedPerPass() {
        var guide = PassGuide()
        for i in 0..<10 { guide.add(yaw: yaw(sector: i), pitchDegrees: -5) }
        #expect(guide.current.count == 10)
        #expect(guide.current.isGood)
        let advanced = guide.advance()
        #expect(advanced)
        #expect(guide.pass == .low)
        #expect(guide.current.count == 0, "the second pass starts with its own coverage")
        #expect(guide.coverage[0].count == 10)
    }

    @Test func lowPassOnlyCountsFramesTiltedDown() {
        var guide = PassGuide(pass: .low)
        let level = guide.add(yaw: yaw(sector: 0), pitchDegrees: 0)
        let tilted = guide.add(yaw: yaw(sector: 0), pitchDegrees: -30)
        let again = guide.add(yaw: yaw(sector: 0), pitchDegrees: -30)
        #expect(!level, "level frames don't count in the low pass")
        #expect(tilted)
        #expect(!again, "a sector lights once")
        #expect(guide.current.count == 1)
    }

    @Test func postureHints() {
        #expect(ScanPass.low.postureHint(pitchDegrees: 0) == "Tilt the phone down toward the floor")
        #expect(ScanPass.low.postureHint(pitchDegrees: -25) == nil)
        #expect(ScanPass.chest.postureHint(pitchDegrees: -60) != nil)
        #expect(ScanPass.chest.postureHint(pitchDegrees: -10) == nil)
        #expect(ScanPass.middle.postureHint(pitchDegrees: 10) == nil)
    }

    @Test func promptSaysWhatToDoNext() {
        var guide = PassGuide()
        #expect(guide.prompt == ScanPass.chest.instruction)
        guide.add(yaw: yaw(sector: 0), pitchDegrees: 0)
        #expect(guide.prompt.hasSuffix("1/12 directions so far."))
        for i in 1..<10 { guide.add(yaw: yaw(sector: i), pitchDegrees: 0) }
        #expect(guide.prompt.contains("Tap Next pass"))
        #expect(guide.prompt.contains("tilt it down"))

        guide.advance()
        #expect(guide.prompt == ScanPass.low.instruction)
        for i in 0..<10 { guide.add(yaw: yaw(sector: i), pitchDegrees: -30) }
        #expect(guide.prompt.contains("through the middle"))

        guide.advance()
        for i in 0..<12 { guide.add(yaw: yaw(sector: i), pitchDegrees: 0) }
        #expect(guide.prompt.contains("Tap Done"))
        let fourth = guide.advance()
        #expect(!fourth, "there is no fourth pass")
        #expect(guide.pass == .middle)
    }

    @Test func pitchFromCameraPose() {
        // ARKit camera looks along −Z. Identity looks level; rotating about +X by −30° looks 30° down.
        #expect(abs(Pose.pitchDegrees(matrix_identity_float4x4)) < 1e-4)
        let down = simd_float4x4(simd_quatf(angle: -.pi / 6, axis: SIMD3(1, 0, 0)))
        #expect(abs(Pose.pitchDegrees(down) + 30) < 1e-3)
    }
}
