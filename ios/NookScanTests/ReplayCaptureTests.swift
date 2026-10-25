import CoreGraphics
import ImageIO
import simd
import XCTest
@testable import NookScan

/// Replays fixtures/capture-small through the same selector and writer as live capture, and checks the
/// output against contract §4. evals/ios_build.sh then runs validate_capture.py on the folder this writes.
final class ReplayCaptureTests: XCTestCase {
    static var fixture: URL {
        Bundle(for: ReplayCaptureTests.self).url(forResource: "capture-small", withExtension: nil)!
    }

    func testReplayWritesValidCapture() throws {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("nook-eval-capture", isDirectory: true)
        try? FileManager.default.removeItem(at: out)

        let source = try ReplayCaptureSource(folder: Self.fixture)
        let summary = try source.record(into: out)

        let src = try json(Self.fixture.appendingPathComponent("transforms.json"))
        let srcFrames = try XCTUnwrap(src["frames"] as? [[String: Any]])
        let t = try json(out.appendingPathComponent("transforms.json"))
        let meta = try json(out.appendingPathComponent("meta.json"))
        let frames = try XCTUnwrap(t["frames"] as? [[String: Any]])

        // Every fixture frame moved ≥ 8 cm and is sharp, so all of them are keyframes.
        XCTAssertEqual(frames.count, srcFrames.count)
        XCTAssertGreaterThanOrEqual(frames.count, 30)
        XCTAssertEqual(summary.frameCount, frames.count)

        // transforms.json: single OPENCV camera, intrinsics unchanged (images are already ≤ 1920 px).
        XCTAssertEqual(t["camera_model"] as? String, "OPENCV")
        XCTAssertEqual(t["w"] as? Int, 480)
        XCTAssertEqual(t["h"] as? Int, 360)
        XCTAssertEqual(try XCTUnwrap(t["fl_x"] as? Double), 384.0803, accuracy: 1e-3)
        XCTAssertEqual(try XCTUnwrap(t["fl_y"] as? Double), 384.0803, accuracy: 1e-3)
        XCTAssertEqual(try XCTUnwrap(t["cx"] as? Double), 240, accuracy: 1e-3)
        XCTAssertEqual(try XCTUnwrap(t["cy"] as? Double), 180, accuracy: 1e-3)
        XCTAssertEqual(t["ply_file_path"] as? String, "points.ply")

        var positions: [SIMD3<Double>] = []
        for (i, f) in frames.enumerated() {
            let name = String(format: "%06d", i + 1)
            XCTAssertEqual(f["file_path"] as? String, "images/\(name).jpg")
            XCTAssertEqual(f["depth_file_path"] as? String, "depth/\(name).png")
            XCTAssertNil(f["fl_x"], "no per-frame intrinsics override expected")

            // Image: JPEG at w × h.
            let img = try XCTUnwrap(ImageUtils.loadImage(out.appendingPathComponent("images/\(name).jpg")))
            XCTAssertEqual(img.width, 480)
            XCTAssertEqual(img.height, 360)

            // Depth: 16-bit PNG, same millimeters as the source.
            let depth = try XCTUnwrap(ImageUtils.readPNG16(out.appendingPathComponent("depth/\(name).png")))
            XCTAssertEqual(depth.width, 256)
            XCTAssertEqual(depth.height, 192)
            if i == 0 || i == frames.count - 1 {
                let srcDepth = try XCTUnwrap(ImageUtils.readPNG16(Self.fixture.appendingPathComponent("depth/\(name).png")))
                XCTAssertEqual(depth.values, srcDepth.values)
            }

            // Pose: the source matrix as-is, orthonormal, bottom row [0,0,0,1].
            let m = try XCTUnwrap(f["transform_matrix"] as? [[Double]])
            let sm = try XCTUnwrap(srcFrames[i]["transform_matrix"] as? [[Double]])
            for r in 0..<4 { for c in 0..<4 { XCTAssertEqual(m[r][c], sm[r][c], accuracy: 1e-5) } }
            XCTAssertEqual(m[3], [0, 0, 0, 1])
            let rot = simd_double3x3(rows: (0..<3).map { r in SIMD3(m[r][0], m[r][1], m[r][2]) })
            XCTAssertLessThan(abs(rot.determinant - 1), 1e-3)
            let rtr = rot.transpose * rot
            for a in 0..<3 { for b in 0..<3 { XCTAssertEqual(rtr[a][b], a == b ? 1 : 0, accuracy: 1e-3) } }
            positions.append(SIMD3(m[0][3], m[1][3], m[2][3]))
            XCTAssertEqual(try XCTUnwrap(f["timestamp"] as? Double), try XCTUnwrap(srcFrames[i]["timestamp"] as? Double), accuracy: 1e-3)
        }
        let lo = positions.reduce(positions[0]) { simd_min($0, $1) }
        let hi = positions.reduce(positions[0]) { simd_max($0, $1) }
        XCTAssertGreaterThanOrEqual(simd_length(hi - lo), 0.5, "camera positions must span ≥ 0.5 m")

        // meta.json
        XCTAssertEqual(meta["version"] as? Int, 1)
        XCTAssertEqual(meta["app"] as? String, "nook-scan")
        XCTAssertEqual(meta["app_version"] as? String, "0.1.0")
        XCTAssertEqual(meta["world"] as? String, "arkit-gravity-y-up-meters")
        XCTAssertEqual(meta["lidar"] as? Bool, true)
        XCTAssertEqual(meta["frame_count"] as? Int, frames.count)
        XCTAssertEqual(try XCTUnwrap(meta["floor_y"] as? Double), -1.35, accuracy: 1e-6)
        XCTAssertNotNil(ISO8601DateFormatter().date(from: try XCTUnwrap(meta["created"] as? String)))
        XCTAssertFalse((meta["device"] as? String ?? "").isEmpty)

        // points.ply: back-projected seeds land on the fixture's geometry (floor at −1.35, inside the room).
        let ply = try readPLY(out.appendingPathComponent("points.ply"))
        XCTAssertEqual(ply.count, summary.pointCount)
        XCTAssertGreaterThan(ply.count, 5_000)
        let ys = ply.map(\.position.y).sorted()
        XCTAssertEqual(Double(ys[ys.count / 100]), -1.35, accuracy: 0.03, "1st percentile of y should be the floor")
        let ref = try readPLY(Self.fixture.appendingPathComponent("points.ply"))
        let refLo = ref.reduce(ref[0].position) { simd_min($0, $1.position) }, refHi = ref.reduce(ref[0].position) { simd_max($0, $1.position) }
        let inside = ply.filter { all($0.position .>= refLo - 0.05) && all($0.position .<= refHi + 0.05) }.count
        XCTAssertGreaterThan(Double(inside) / Double(ply.count), 0.99, "seed points should lie inside the fixture's point bounds")
        XCTAssertTrue(ply.contains { $0.color != SIMD3(0, 0, 0) }, "seed points carry image colors")
    }

    func testShareZipHasSingleTopLevelFolder() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("zip-test-\(UUID().uuidString)", isDirectory: true)
        let folder = tmp.appendingPathComponent("scan-20261025-153000", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try FileManager.default.copyItem(at: Self.fixture, to: folder)

        let zip = try CaptureStore.makeZip(of: folder)
        defer { CaptureStore.clearShareFolder() }
        XCTAssertEqual(zip.lastPathComponent, "scan-20261025-153000.zip")
        let names = try zipEntryNames(zip)
        XCTAssertTrue(names.contains("scan-20261025-153000/transforms.json"))
        XCTAssertEqual(Set(names.map { String($0.split(separator: "/")[0]) }), ["scan-20261025-153000"])
    }

    func testCaptureStoreListsCaptures() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("store-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = CaptureStore.newCaptureFolder(in: root)
        XCTAssertNotNil(folder.lastPathComponent.range(of: #"^scan-\d{8}-\d{6}$"#, options: .regularExpression))
        try FileManager.default.copyItem(at: Self.fixture, to: folder)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scan-20200101-000000"), withIntermediateDirectories: true)

        let list = CaptureStore.scan(root)
        XCTAssertEqual(list.count, 2)
        XCTAssertEqual(list[0].frameCount, 40)
        XCTAssertTrue(list[0].lidar)
        XCTAssertGreaterThan(list[0].sizeBytes, 1_000_000)
        XCTAssertNotNil(list[0].date)
        XCTAssertNil(list[1].frameCount, "a folder without meta.json is incomplete")
        XCTAssertNotEqual(CaptureStore.newCaptureFolder(in: root), folder)
    }

    func testWriterDownscalesLargeImagesAndScalesIntrinsics() throws {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("writer-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: out) }
        let writer = try CaptureWriter(folder: out, info: CaptureInfo(device: "test", lidar: false))
        let ctx = try XCTUnwrap(CGContext(data: nil, width: 3840, height: 2880, bitsPerComponent: 8, bytesPerRow: 0,
                                          space: ImageUtils.sRGB, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        ctx.setFillColor(gray: 0.5, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: 3840, height: 2880))
        let image = try XCTUnwrap(ctx.makeImage())
        let k = Intrinsics(fx: 2800, fy: 2800, cx: 1920, cy: 1440, width: 3840, height: 2880)
        writer.append(Keyframe(timestamp: 5, transform: matrix_identity_float4x4, intrinsics: k, image: .cgImage(image), depth: nil),
                      index: 1, time: 0)
        let summary = try writer.finish(floorY: nil)
        XCTAssertEqual(summary.frameCount, 1)
        let t = try json(out.appendingPathComponent("transforms.json"))
        XCTAssertEqual(t["w"] as? Int, 1920)
        XCTAssertEqual(t["h"] as? Int, 1440)
        XCTAssertEqual(try XCTUnwrap(t["fl_x"] as? Double), 1400, accuracy: 1e-6)
        XCTAssertEqual(try XCTUnwrap(t["cx"] as? Double), 960, accuracy: 1e-6)
        XCTAssertNil(t["ply_file_path"])
        let meta = try json(out.appendingPathComponent("meta.json"))
        XCTAssertTrue(meta["floor_y"] is NSNull)
        let img = try XCTUnwrap(ImageUtils.loadImage(out.appendingPathComponent("images/000001.jpg")))
        XCTAssertEqual([img.width, img.height], [1920, 1440])
    }

    // MARK: Helpers

    private func json(_ url: URL) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func readPLY(_ url: URL) throws -> [(position: SIMD3<Float>, color: SIMD3<UInt8>)] {
        let data = try Data(contentsOf: url)
        let marker = Data("end_header\n".utf8)
        let end = try XCTUnwrap(data.range(of: marker))
        let header = String(decoding: data[..<end.lowerBound], as: UTF8.self)
        XCTAssertTrue(header.hasPrefix("ply\nformat binary_little_endian 1.0\n"))
        XCTAssertTrue(header.contains("property float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\n"))
        let countLine = try XCTUnwrap(header.split(separator: "\n").first { $0.hasPrefix("element vertex ") })
        let n = try XCTUnwrap(Int(countLine.dropFirst("element vertex ".count)))
        let body = data[end.upperBound...]
        XCTAssertEqual(body.count, n * 15)
        return body.withUnsafeBytes { raw in
            (0..<n).map { i in
                let o = i * 15
                let p = SIMD3((0..<3).map { Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: o + $0 * 4, as: UInt32.self))) })
                return (p, SIMD3(raw[o + 12], raw[o + 13], raw[o + 14]))
            }
        }
    }

    /// File names from a zip's central directory (located through the end-of-central-directory record).
    private func zipEntryNames(_ url: URL) throws -> [String] {
        let data = try Data(contentsOf: url)
        return try data.withUnsafeBytes { raw -> [String] in
            func u16(_ o: Int) -> Int { Int(UInt16(littleEndian: raw.loadUnaligned(fromByteOffset: o, as: UInt16.self))) }
            func u32(_ o: Int) -> Int { Int(UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: o, as: UInt32.self))) }
            let eocd = try XCTUnwrap(stride(from: raw.count - 22, through: 0, by: -1).first { u32($0) == 0x0605_4b50 })
            var o = u32(eocd + 16)
            var names: [String] = []
            for _ in 0..<u16(eocd + 10) {
                XCTAssertEqual(u32(o), 0x0201_4b50)
                let nameLen = u16(o + 28), extraLen = u16(o + 30), commentLen = u16(o + 32)
                names.append(String(decoding: raw[(o + 46)..<(o + 46 + nameLen)], as: UTF8.self))
                o += 46 + nameLen + extraLen + commentLen
            }
            return names
        }
    }
}
