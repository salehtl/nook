import CoreGraphics
import CoreVideo
import simd
import Testing
@testable import NookScan

/// Camera settings, the flicker check and Pause (contract §4.14), and what the writer records.
struct CameraAndScanTests {
    private let isoRange = 25.0...3200.0
    private let durationRange = (1.0 / 8000)...(1.0 / 3)

    private func exposure(_ s: CameraSettings, duration: Double = 0.01, iso: Double = 141) -> AdaptiveShutter.Exposure {
        s.exposure(meteredDuration: duration, meteredISO: iso, isoRange: isoRange, durationRange: durationRange)
    }

    @Test func autoIsTheAdaptiveShutter() {
        #expect(exposure(CameraSettings()) == AdaptiveShutter.exposure(duration: 0.01, iso: 141, minISO: 25, maxISO: 3200))
    }

    @Test func chosenShutterMatchesBrightnessWithISO() {
        let e = exposure(CameraSettings(shutterDenominator: 100), duration: 1.0 / 257, iso: 800)
        #expect(abs(e.duration - 0.01) < 1e-9)
        #expect(abs(e.duration * e.iso - 800.0 / 257) < 1e-6, "same brightness")
        #expect(!e.tooDark)
    }

    @Test func chosenShutterTooFastForTheLightSaysSo() {
        let e = exposure(CameraSettings(shutterDenominator: 1000), duration: 1.0 / 30, iso: 400)
        #expect(e.iso == 3200, "ISO stops at the camera's limit")
        #expect(e.tooDark)
    }

    @Test func chosenISOSetsTheShutterOnAuto() {
        let e = exposure(CameraSettings(iso: 800), duration: 0.01, iso: 200)
        #expect(e.iso == 800)
        #expect(abs(e.duration - 0.0025) < 1e-9)
    }

    @Test func bothChosenAreUsedAsGiven() {
        let e = exposure(CameraSettings(shutterDenominator: 250, iso: 100), duration: 0.01, iso: 800)
        #expect(e.iso == 100 && abs(e.duration - 0.004) < 1e-9)
        #expect(e.tooDark, "far darker than auto exposure's picture")
    }

    @Test func settingsSurviveEncoding() throws {
        let s = CameraSettings(shutterDenominator: 120, iso: 640, takeStills: false)
        let back = try JSONDecoder().decode(CameraSettings.self, from: JSONEncoder().encode(s))
        #expect(back == s)
        #expect(!back.isAuto)
        #expect(CameraSettings().isAuto)
    }

    /// Feeds lumas until the probe does something other than wait.
    private func run(_ probe: inout FlickerProbe, from t: inout Double, luma: (Int) -> Float) -> FlickerProbe.Action {
        for i in 0..<200 {
            t += 1.0 / 60
            let action = probe.add(luma: luma(i), timestamp: t)
            if action != .wait { return action }
        }
        return .wait
    }

    private let steady: (Int) -> Float = { _ in 120 }
    private let flickering: (Int) -> Float = { 120 * ($0.isMultiple(of: 2) ? 1 : 1.2) }

    @Test func steadyLightsKeepTheFastShutter() {
        var probe = FlickerProbe(), t = 0.0
        let action = run(&probe, from: &t, luma: steady)
        guard case .done(let shutter, let ev) = action else { Issue.record("got \(action)"); return }
        #expect(shutter == nil)
        #expect(ev < FlickerMeter.flickerEV)
    }

    @Test func flickerMovesToTheFirstSafeShutterThatIsSteady() {
        var probe = FlickerProbe(), t = 0.0
        #expect(run(&probe, from: &t, luma: flickering) == .relock(1.0 / 100))
        let action = run(&probe, from: &t, luma: steady)
        guard case .done(let shutter, let ev) = action else { Issue.record("got \(action)"); return }
        #expect(shutter == 1.0 / 100)
        #expect(ev > 0.2, "reports what it measured at the fast shutter")
    }

    @Test func sixtyHertzLandsOn120th() {
        var probe = FlickerProbe(), t = 0.0
        #expect(run(&probe, from: &t, luma: flickering) == .relock(1.0 / 100))
        #expect(run(&probe, from: &t, luma: flickering) == .relock(1.0 / 120))
        let action = run(&probe, from: &t, luma: steady)
        guard case .done(let shutter, _) = action else { Issue.record("got \(action)"); return }
        #expect(shutter == 1.0 / 120)
    }

    @Test func flickerNoShutterFixesStillFinishes() {
        var probe = FlickerProbe(), t = 0.0
        _ = run(&probe, from: &t, luma: flickering)
        _ = run(&probe, from: &t, luma: { 120 * ($0.isMultiple(of: 2) ? 1 : 1.1) })
        let action = run(&probe, from: &t, luma: flickering)
        guard case .done(let shutter, _) = action else { Issue.record("got \(action)"); return }
        #expect(shutter == 1.0 / 100, "the steadier of the two")
    }

    /// Records a scan with the flicker check and Pause, through the same recorder live capture uses.
    @Test func recorderChecksFlickerThenKeepsFramesAndHonoursPause() throws {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("recorder-06-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: out) }
        var relocked: [Double] = []
        let start = CameraLock(exposureLocked: true, whiteBalanceLocked: true, iso: 800, exposureDuration: 1.0 / 257)
        let recorder = try CaptureRecorder(folder: out, info: CaptureInfo(device: "test", lidar: false), lockCamera: { start }, relockCamera: { shutter in
            relocked.append(shutter)
            var lock = start
            lock.exposureDuration = shutter
            return lock
        })
        var i = 0
        var x: Float = 0
        func feed(_ n: Int, moving: Bool = false, luma: @escaping (Int) -> Float) -> [FrameDecision] {
            (0..<n).map { _ in
                i += 1
                if moving { x += 0.05 }
                let d = recorder.handle(Frame(timestamp: Double(i) / 60, x: x, luma: luma(i)))
                Thread.sleep(forTimeInterval: 0.003)
                return d
            }
        }
        let beforeLock = feed(61, luma: flickering)   // a second of tracking, then the lock
        #expect(beforeLock.allSatisfy { $0 == .waitingForLock })
        #expect(recorder.lockState != .settling(normalSince: nil))
        var checking: [FrameDecision] = []
        while relocked.isEmpty && checking.count < 200 { checking += feed(1, luma: flickering) }
        #expect(checking.allSatisfy { $0 == .waitingForLock }, "nothing is kept during the check")
        #expect(relocked == [1.0 / 100])
        #expect(recorder.isCheckingFlicker)
        _ = feed(60, luma: { _ in 120 })
        #expect(!recorder.isCheckingFlicker)
        let settled = feed(20, moving: true, luma: { _ in 120 })
        #expect(settled.last == .keep)
        if case .locked(let lock) = recorder.lockState {
            #expect(lock.flickerDetected)
            #expect(lock.exposureDuration == 1.0 / 100)
            #expect((lock.flickerEV ?? 0) > 0.2)
        } else {
            Issue.record("not locked: \(recorder.lockState)")
        }

        let kept = recorder.keptCount
        recorder.isPaused = true
        #expect(feed(20, moving: true, luma: { _ in 120 }).allSatisfy { $0 == .paused })
        #expect(recorder.keptCount == kept, "nothing is saved while paused")
        recorder.isPaused = false
        #expect(feed(5, moving: true, luma: { _ in 120 }).contains(.keep), "the first frame after moving is kept again")

        let summary = try recorder.finish(floorY: -1)
        #expect(summary.heightRange == 1...1, "the camera stayed 1 m above the floor")
        let meta = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: out.appendingPathComponent("meta.json"))) as? [String: Any])
        #expect(meta["flicker_detected"] as? Bool == true)
        #expect((meta["flicker_ev"] as? Double ?? 0) > 0.2)
        #expect(meta["camera_settings"] as? String == "auto")
        #expect(abs((meta["lock_exposure_duration"] as? Double ?? 0) - 0.01) < 1e-6)
    }

    /// Walking off during the check must neither count as flicker nor hold the scan up for good.
    @Test func flickerCheckIgnoresMotionAndGivesUp() throws {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("recorder-move-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: out) }
        var relocks = 0
        let start = CameraLock(exposureLocked: true, whiteBalanceLocked: true, iso: 800, exposureDuration: 1.0 / 257)
        let recorder = try CaptureRecorder(folder: out, info: CaptureInfo(device: "test", lidar: false), lockCamera: { start }, relockCamera: { _ in relocks += 1; return start })
        var last = FrameDecision.stopped
        for i in 1...400 {   // about 6.7 s of walking past bright and dark things
            last = recorder.handle(Frame(timestamp: Double(i) / 60, x: Float(i) * 0.05, luma: i.isMultiple(of: 2) ? 100 : 140))
            Thread.sleep(forTimeInterval: 0.002)
        }
        #expect(relocks == 0, "a moving view isn't flicker")
        #expect(!recorder.isCheckingFlicker, "it gives up after a few seconds")
        #expect(last == .keep)
        if case .locked(let lock) = recorder.lockState {
            #expect(!lock.flickerDetected)
            #expect(lock.flickerEV == nil, "nothing was measured")
        } else {
            Issue.record("not locked")
        }
        _ = try recorder.finish(floorY: nil)
    }

    @Test func manualSettingsSkipTheFlickerCheck() throws {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("recorder-man-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: out) }
        var relocks = 0
        let manual = CameraLock(exposureLocked: true, whiteBalanceLocked: true, iso: 400, exposureDuration: 1.0 / 500, isManual: true)
        let recorder = try CaptureRecorder(folder: out, info: CaptureInfo(device: "test", lidar: false), lockCamera: { manual }, relockCamera: { _ in relocks += 1; return nil })
        var last = FrameDecision.stopped
        for i in 1...120 {
            last = recorder.handle(Frame(timestamp: Double(i) / 60, x: Float(i) * 0.05, luma: i.isMultiple(of: 2) ? 100 : 140))
            Thread.sleep(forTimeInterval: 0.003)
        }
        #expect(last == .keep)
        #expect(relocks == 0)
        #expect(!recorder.isCheckingFlicker)
        _ = try recorder.finish(floorY: nil)
        let meta = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: out.appendingPathComponent("meta.json"))) as? [String: Any])
        #expect(meta["camera_settings"] as? String == "manual")
        #expect(meta["flicker_detected"] == nil)
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

    @Test func pitchFromCameraPose() {
        #expect(abs(Pose.pitchDegrees(matrix_identity_float4x4)) < 1e-4)
        let down = simd_float4x4(simd_quatf(angle: -.pi / 6, axis: SIMD3(1, 0, 0)))
        #expect(abs(Pose.pitchDegrees(down) + 30) < 1e-3)
    }

    /// A still (§4.10) is stored at most 2880 px with matching intrinsics, frames carry no pass, and the ending is
    /// recorded (§4.13). Every size and key is read back from what was written.
    @Test func writerRecordsStillsAndEnding() throws {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("writer-06-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: out) }
        let writer = try CaptureWriter(folder: out, info: CaptureInfo(device: "test", lidar: false))
        var buffer: CVPixelBuffer?
        let attrs = [kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()] as CFDictionary
        #expect(CVPixelBufferCreate(nil, 4032, 3024, kCVPixelFormatType_32BGRA, attrs, &buffer) == kCVReturnSuccess)
        let pb = try #require(buffer)
        let full = Intrinsics(fx: 2856, fy: 2856, cx: 2016, cy: 1512, width: 4032, height: 3024)
        var kf = Keyframe(timestamp: 1, transform: matrix_identity_float4x4, intrinsics: full, image: .pixelBuffer(pb), depth: nil)
        kf.still = Still(image: pb, intrinsics: full)
        writer.append(kf, index: 1, time: 0)
        _ = try writer.finish(floorY: nil, ending: .failed("ARKit stopped"))

        let transforms = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: out.appendingPathComponent("transforms.json"))) as? [String: Any])
        let frames = try #require(transforms["frames"] as? [[String: Any]])
        #expect(frames[0].keys.contains("pass") == false)
        #expect(frames[0].keys.contains("test_walk") == false)
        #expect(frames[0]["hires_w"] as? Int == 2880)
        #expect(frames[0]["hires_h"] as? Int == 2160)
        #expect(abs((frames[0]["hires_fl_x"] as? Double ?? 0) - 2040) < 1e-6)
        let jpeg = try #require(ImageUtils.loadImage(out.appendingPathComponent("images_hi/000001.jpg")))
        #expect(jpeg.width == 2880)
        #expect(jpeg.height == 2160)
        let meta = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: out.appendingPathComponent("meta.json"))) as? [String: Any])
        #expect(meta["end_reason"] as? String == "failed")
        #expect(meta["end_message"] as? String == "ARKit stopped")
        #expect(meta["thermal_state"] as? String != nil)
    }
}

/// A walking frame with a set brightness.
private struct Frame: CaptureFrame {
    let timestamp: Double
    let x: Float
    let luma: Float

    var tracking: TrackingStatus { .normal }
    var transform: simd_float4x4 {
        var m = matrix_identity_float4x4
        m.columns.3 = SIMD4(x, 0, 0, 1)
        return m
    }
    func sharpness() -> Float { 100 }
    func meanLuma() -> Float? { luma }
    func makeKeyframe() -> Keyframe? {
        guard let image = Self.image else { return nil }
        return Keyframe(timestamp: timestamp, transform: transform,
                        intrinsics: Intrinsics(fx: 50, fy: 50, cx: 32, cy: 24, width: 64, height: 48),
                        image: .cgImage(image), depth: nil)
    }
    static let image: CGImage? = {
        guard let ctx = CGContext(data: nil, width: 64, height: 48, bitsPerComponent: 8, bytesPerRow: 0, space: ImageUtils.sRGB,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(gray: 0.5, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        return ctx.makeImage()
    }()
}
