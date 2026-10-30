import CoreGraphics
import Foundation
import simd
import Testing
@testable import NookScan

/// Exposure and white-balance lock (contract §4.8): lock once tracking has been normal for about 1 s, keep no
/// keyframes before that, and record what was locked.
struct ExposureLockTests {
    let fullLock = CameraLock(exposureLocked: true, whiteBalanceLocked: true, iso: 320, exposureDuration: 1.0 / 60,
                              whiteBalanceGains: WhiteBalanceGains(r: 2.1, g: 1, b: 1.7))

    /// Feeds (tracking, timestamp) pairs and returns what `shouldLock` answered for each.
    private func feed(_ policy: inout ExposureLockPolicy, _ frames: [(TrackingStatus, Double)]) -> [Bool] {
        frames.map { policy.shouldLock(tracking: $0.0, timestamp: $0.1) }
    }

    @Test func locksAfterOneSecondOfNormalTracking() {
        var policy = ExposureLockPolicy(canLock: true)
        #expect(!policy.allowsKeyframes)
        let answers = feed(&policy, [(.normal, 10), (.normal, 10.5), (.normal, 10.99), (.normal, 11)])
        #expect(answers == [false, false, false, true])
        #expect(policy.state == .locking)
        #expect(!policy.allowsKeyframes, "nothing is kept until the lock is in place")

        policy.didLock(fullLock)
        #expect(policy.state == .locked(fullLock))
        #expect(policy.allowsKeyframes)
        #expect(policy.record == fullLock)
        let later = feed(&policy, [(.normal, 20), (.limited("Moving too fast"), 21)])
        #expect(later == [false, false], "locks only once")
        #expect(policy.allowsKeyframes, "tracking trouble after the lock doesn't undo it")
    }

    @Test func trackingTroubleRestartsTheWait() {
        var policy = ExposureLockPolicy(canLock: true)
        let first = feed(&policy, [(.normal, 0), (.normal, 0.8), (.limited("Starting up"), 0.9)])
        #expect(first == [false, false, false])
        #expect(policy.state == .settling(normalSince: nil))
        let second = feed(&policy, [(.normal, 1.2), (.notAvailable, 1.3), (.normal, 1.4), (.normal, 2.3), (.normal, 2.4)])
        #expect(second == [false, false, false, false, true], "a full second of normal tracking since 1.4")
    }

    @Test func settleTimeIsConfigurable() {
        var policy = ExposureLockPolicy(canLock: true, settleSeconds: 0.5)
        #expect(feed(&policy, [(.normal, 3), (.normal, 3.5)]) == [false, true])
    }

    @Test func cameraThatWontLockStillRecords() {
        var policy = ExposureLockPolicy(canLock: true)
        #expect(feed(&policy, [(.normal, 0), (.normal, 1)]) == [false, true])
        policy.didLock(.none)
        #expect(policy.state == .unlockable)
        #expect(policy.allowsKeyframes, "an unlocked capture beats no capture")
        #expect(policy.record == .none)
    }

    @Test func partialLockIsRecordedAsIs() {
        var policy = ExposureLockPolicy(canLock: true)
        _ = feed(&policy, [(.normal, 0), (.normal, 1)])
        let exposureOnly = CameraLock(exposureLocked: true, iso: 100, exposureDuration: 0.01)
        policy.didLock(exposureOnly)
        #expect(policy.allowsKeyframes)
        #expect(policy.record.exposureLocked)
        #expect(!policy.record.whiteBalanceLocked)
    }

    @Test func replayNeedsNoLock() {
        var policy = ExposureLockPolicy(canLock: false)
        #expect(policy.state == .notApplicable)
        #expect(policy.allowsKeyframes)
        #expect(feed(&policy, [(.normal, 5), (.normal, 7)]) == [false, false])
        policy.didLock(fullLock)
        #expect(policy.state == .notApplicable, "a stray report doesn't change anything")
        #expect(policy.record == .none)
    }

    /// The whole path: recorder → policy → writer. Frames 0.1 s and 10 cm apart; tracking is limited for the first
    /// half second, so the lock lands at t = 1.5 s. Frames still in the camera pipeline then pass for
    /// CaptureRecorder.lockSettle (0.3 s), so the first keyframe is the one at t = 1.8 s.
    @Test func recorderKeepsNoKeyframesBeforeTheLock() throws {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("lock-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: out) }
        var lockCalls = 0
        let lock = fullLock
        let recorder = try CaptureRecorder(folder: out, info: CaptureInfo(device: "test", lidar: false)) {
            lockCalls += 1
            return lock
        }
        #expect(recorder.lockState == .settling(normalSince: nil))

        var decisions: [FrameDecision] = []
        for i in 0..<40 {
            if i == 30 { recorder.pass = .low }
            let frame = FakeFrame(timestamp: Double(i) / 10, x: Float(i) / 10, tracking: i < 5 ? .limited("Starting up") : .normal)
            decisions.append(recorder.handle(frame))
            Thread.sleep(forTimeInterval: 0.003)   // let the writer keep up, so no frame is dropped as busy
        }
        #expect(decisions[..<18].allSatisfy { $0 == .waitingForLock })
        #expect(decisions[18...].allSatisfy { $0 == .keep })
        #expect(lockCalls == 1)
        #expect(recorder.lockState == .locked(lock))

        let summary = try recorder.finish(floorY: nil)
        #expect(summary.frameCount == 22)

        let meta = try json(out.appendingPathComponent("meta.json"))
        #expect(meta["exposure_locked"] as? Bool == true)
        #expect(meta["white_balance_locked"] as? Bool == true)
        #expect(meta["lock_iso"] as? Double == 320)
        #expect(abs(try #require(meta["lock_exposure_duration"] as? Double) - 1.0 / 60) < 1e-6)
        let gains = try #require(meta["lock_white_balance_gains"] as? [String: Double])
        #expect(gains == ["r": 2.1, "g": 1, "b": 1.7])

        let frames = try #require(try json(out.appendingPathComponent("transforms.json"))["frames"] as? [[String: Any]])
        #expect(frames.count == 22)
        #expect(frames.allSatisfy { abs(($0["exposure_duration"] as? Double ?? 0) - 1.0 / 60) < 1e-6 })
        #expect(frames.allSatisfy { $0["exposure_offset"] as? Double == -0.5 })
        #expect(frames.prefix(12).allSatisfy { $0["pass"] as? Int == 1 })
        #expect(frames.suffix(10).allSatisfy { $0["pass"] as? Int == 2 })
        #expect(frames.first?["timestamp"] as? Double == 0, "time starts at the first kept keyframe")
    }

    @Test func writerOmitsLockValuesThatWerentLocked() throws {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("lock-writer-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: out) }
        let writer = try CaptureWriter(folder: out, info: CaptureInfo(device: "test", lidar: false))
        let kf = try #require(FakeFrame(timestamp: 0, x: 0, tracking: .normal).makeKeyframe())
        writer.append(kf, index: 1, time: 0)
        _ = try writer.finish(floorY: -1.2, cameraLock: CameraLock(whiteBalanceLocked: true, iso: 50,
                                                                   whiteBalanceGains: WhiteBalanceGains(r: 1.5, g: 1, b: 2)))
        let meta = try json(out.appendingPathComponent("meta.json"))
        #expect(meta["exposure_locked"] as? Bool == false)
        #expect(meta["white_balance_locked"] as? Bool == true)
        #expect(meta["lock_iso"] == nil, "ISO is only recorded when exposure was locked")
        #expect(meta["lock_exposure_duration"] == nil)
        #expect(meta["lock_white_balance_gains"] != nil)
    }

    private func json(_ url: URL) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    @Test func adaptiveShutterOrdinaryRoomStaysWithinTheISOBudget() {
        // the majlis scan: auto exposure settled at 1/100 s, ISO 141 -> ISO 800 at about 1/567 s
        let e = AdaptiveShutter.exposure(duration: 0.01, iso: 141, minISO: 25, maxISO: 3000)
        #expect(e.iso == AdaptiveShutter.isoBudget)
        #expect(e.duration < AdaptiveShutter.slowest && e.duration > AdaptiveShutter.fastest)
        #expect(abs(e.duration * e.iso - 0.01 * 141) < 1e-6, "same exposure, so the same brightness")
        #expect(!e.tooDark)
    }

    @Test func adaptiveShutterBrightRoomGoesTo1000th() {
        let e = AdaptiveShutter.exposure(duration: 1.0 / 120, iso: 50, minISO: 25, maxISO: 3000)
        #expect(abs(e.duration - AdaptiveShutter.fastest) < 1e-9)
        #expect(abs(e.duration * e.iso - 50.0 / 120) < 1e-6)
    }

    @Test func adaptiveShutterDimRoomPassesTheBudgetToHold250th() {
        let e = AdaptiveShutter.exposure(duration: 1.0 / 30, iso: 200, minISO: 25, maxISO: 3000)
        #expect(abs(e.duration - AdaptiveShutter.slowest) < 1e-9)
        #expect(e.iso > AdaptiveShutter.isoBudget && !e.tooDark)
    }

    @Test func adaptiveShutterTooDarkLengthensAndSaysSo() {
        let e = AdaptiveShutter.exposure(duration: 1.0 / 30, iso: 1600, minISO: 25, maxISO: 2000)
        #expect(e.iso == 2000 && e.tooDark)
        #expect(e.duration > AdaptiveShutter.slowest && e.duration < 1.0 / 30)
    }

    @Test func adaptiveShutterNeverSlowsAutoExposureDown() {
        let e = AdaptiveShutter.exposure(duration: 1.0 / 4000, iso: 25, minISO: 25, maxISO: 3000)
        #expect(e.duration == 1.0 / 4000 && e.iso == 25)
    }

    @Test func slowDownWarningFollowsPredictedBlur() {
        var m = MotionMonitor()
        var t = simd_float4x4(1)
        for i in 0..<60 {  // turning at 30°/s
            t = simd_float4x4(simd_quatf(angle: Float(i) * 0.5 * .pi / 180, axis: [0, 1, 0]))
            m.update(timestamp: Double(i) / 60, transform: t)
        }
        #expect(!m.isTooFast, "30°/s is under the 60°/s speed limit before the shutter is known")
        m.exposure = 1.0 / 100
        #expect(m.isTooFast, "about 7 px of blur at 1/100 s")
        m.exposure = 1.0 / 1000
        #expect(!m.isTooFast, "under 1 px at 1/1000 s")
    }
}

/// A synthetic frame: a small textured image, walking along +X, exposure as ARKit would report it.
private struct FakeFrame: CaptureFrame {
    let timestamp: Double
    let x: Float
    let tracking: TrackingStatus

    var transform: simd_float4x4 {
        var m = matrix_identity_float4x4
        m.columns.3 = SIMD4(x, 0, 0, 1)
        return m
    }

    func sharpness() -> Float { 100 }

    func makeKeyframe() -> Keyframe? {
        guard let image = Self.image else { return nil }
        return Keyframe(timestamp: timestamp, transform: transform,
                        intrinsics: Intrinsics(fx: 50, fy: 50, cx: 32, cy: 24, width: 64, height: 48),
                        image: .cgImage(image), depth: nil, exposureDuration: 1.0 / 60, exposureOffset: -0.5)
    }

    static let image: CGImage? = {
        guard let ctx = CGContext(data: nil, width: 64, height: 48, bitsPerComponent: 8, bytesPerRow: 0, space: ImageUtils.sRGB,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        for y in 0..<6 {
            for x in 0..<8 {
                ctx.setFillColor(gray: (x + y).isMultiple(of: 2) ? 0.9 : 0.1, alpha: 1)
                ctx.fill(CGRect(x: x * 8, y: y * 8, width: 8, height: 8))
            }
        }
        return ctx.makeImage()
    }()
}
