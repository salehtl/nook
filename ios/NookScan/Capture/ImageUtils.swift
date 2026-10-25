import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum ImageError: LocalizedError {
    case encode(String)
    case decode(String)

    var errorDescription: String? {
        switch self {
        case .encode(let s): return "Could not write \(s)"
        case .decode(let s): return "Could not read \(s)"
        }
    }
}

enum ImageUtils {
    static let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
    static let gray = CGColorSpaceCreateDeviceGray()

    // MARK: Sharpness

    /// Variance of the 4-neighbour Laplacian of an 8-bit luma plane, sampled on a grid about `targetWidth` wide.
    /// Sharp images score high; blur flattens the Laplacian.
    static func sharpness(luma base: UnsafePointer<UInt8>, width: Int, height: Int, bytesPerRow: Int, targetWidth: Int = 480) -> Float {
        let step = max(1, width / targetWidth)
        let w = width / step, h = height / step
        guard w >= 3, h >= 3 else { return 0 }
        let rowStride = step * bytesPerRow
        var sum = 0.0, sumSq = 0.0
        for y in 1..<(h - 1) {
            let up = base + (y - 1) * rowStride, mid = base + y * rowStride, down = base + (y + 1) * rowStride
            for x in 1..<(w - 1) {
                let o = x * step
                let l = Int(mid[o - step]) + Int(mid[o + step]) + Int(up[o]) + Int(down[o]) - 4 * Int(mid[o])
                let d = Double(l)
                sum += d
                sumSq += d * d
            }
        }
        let n = Double((w - 2) * (h - 2))
        let mean = sum / n
        return Float(sumSq / n - mean * mean)
    }

    /// Sharpness of the luma (Y) plane of a bi-planar YCbCr buffer such as ARFrame.capturedImage.
    static func sharpness(ofLumaPlaneOf pb: CVPixelBuffer) -> Float {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard CVPixelBufferIsPlanar(pb), let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else { return 0 }
        return sharpness(luma: base.assumingMemoryBound(to: UInt8.self),
                         width: CVPixelBufferGetWidthOfPlane(pb, 0),
                         height: CVPixelBufferGetHeightOfPlane(pb, 0),
                         bytesPerRow: CVPixelBufferGetBytesPerRowOfPlane(pb, 0))
    }

    /// Sharpness of a CGImage, rendered to gray at most `targetWidth` wide.
    static func sharpness(of image: CGImage, targetWidth: Int = 480) -> Float {
        let w = min(image.width, targetWidth)
        let h = max(3, Int((Double(image.height) * Double(w) / Double(image.width)).rounded()))
        var data = [UInt8](repeating: 0, count: w * h)
        let ok = data.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                      space: gray, bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            ctx.interpolationQuality = .medium
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return 0 }
        return data.withUnsafeBufferPointer { sharpness(luma: $0.baseAddress!, width: w, height: h, bytesPerRow: w, targetWidth: w) }
    }

    // MARK: Pixel buffers

    /// Deep copy of a pixel buffer into a new buffer we own, so ARKit's pool buffer can be released right away.
    static func copyPixelBuffer(_ src: CVPixelBuffer) -> CVPixelBuffer? {
        let w = CVPixelBufferGetWidth(src), h = CVPixelBufferGetHeight(src)
        var out: CVPixelBuffer?
        let attrs = [kCVPixelBufferIOSurfacePropertiesKey: [String: Any]()] as CFDictionary
        guard CVPixelBufferCreate(nil, w, h, CVPixelBufferGetPixelFormatType(src), attrs, &out) == kCVReturnSuccess,
              let dst = out else { return nil }
        CVPixelBufferLockBaseAddress(src, .readOnly)
        CVPixelBufferLockBaseAddress(dst, [])
        defer {
            CVPixelBufferUnlockBaseAddress(dst, [])
            CVPixelBufferUnlockBaseAddress(src, .readOnly)
        }
        func copy(_ s: UnsafeMutableRawPointer?, _ d: UnsafeMutableRawPointer?, rows: Int, sBytes: Int, dBytes: Int) -> Bool {
            guard let s, let d else { return false }
            if sBytes == dBytes {
                memcpy(d, s, rows * sBytes)
            } else {
                for r in 0..<rows { memcpy(d + r * dBytes, s + r * sBytes, min(sBytes, dBytes)) }
            }
            return true
        }
        if CVPixelBufferIsPlanar(src) {
            for p in 0..<CVPixelBufferGetPlaneCount(src) {
                guard copy(CVPixelBufferGetBaseAddressOfPlane(src, p), CVPixelBufferGetBaseAddressOfPlane(dst, p),
                           rows: CVPixelBufferGetHeightOfPlane(src, p),
                           sBytes: CVPixelBufferGetBytesPerRowOfPlane(src, p),
                           dBytes: CVPixelBufferGetBytesPerRowOfPlane(dst, p)) else { return nil }
            }
        } else {
            guard copy(CVPixelBufferGetBaseAddress(src), CVPixelBufferGetBaseAddress(dst), rows: h,
                       sBytes: CVPixelBufferGetBytesPerRow(src), dBytes: CVPixelBufferGetBytesPerRow(dst)) else { return nil }
        }
        CVBufferPropagateAttachments(src, dst)
        return dst
    }

    // MARK: Drawing

    /// Draws `image` into a new opaque sRGB image of `width × height`.
    static func resized(_ image: CGImage, width: Int, height: Int) -> CGImage? {
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: sRGB, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage()
    }

    /// RGBX bytes of `image` resampled to `width × height`, top row first.
    static func rgbxPixels(_ image: CGImage, width: Int, height: Int) -> [UInt8]? {
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let ok = data.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: sRGB,
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            ctx.interpolationQuality = .medium
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return ok ? data : nil
    }

    // MARK: Files

    static func loadImage(_ url: URL) -> CGImage? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    }

    static func writeJPEG(_ image: CGImage, to url: URL, quality: Double) throws {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw ImageError.encode(url.lastPathComponent)
        }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw ImageError.encode(url.lastPathComponent) }
    }

    /// 16-bit grayscale PNG (row-major, top row first).
    static func writePNG16(_ values: [UInt16], width: Int, height: Int, to url: URL) throws {
        precondition(values.count == width * height)
        let data = values.map(\.littleEndian).withUnsafeBytes { Data($0) }
        guard let provider = CGDataProvider(data: data as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 16, bitsPerPixel: 16, bytesPerRow: width * 2,
                                  space: gray,
                                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue | CGBitmapInfo.byteOrder16Little.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
              let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw ImageError.encode(url.lastPathComponent)
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw ImageError.encode(url.lastPathComponent) }
    }

    /// Reads a 16-bit grayscale PNG as raw values (no color management).
    static func readPNG16(_ url: URL) -> (width: Int, height: Int, values: [UInt16])? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCache: false] as CFDictionary),
              image.bitsPerComponent == 16, image.bitsPerPixel == 16,
              let cf = image.dataProvider?.data else { return nil }
        let data = cf as Data
        let w = image.width, h = image.height, rowBytes = image.bytesPerRow
        let little = image.bitmapInfo.rawValue & CGBitmapInfo.byteOrderMask.rawValue == CGBitmapInfo.byteOrder16Little.rawValue
        guard data.count >= (h - 1) * rowBytes + w * 2 else { return nil }
        var values = [UInt16](repeating: 0, count: w * h)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            for y in 0..<h {
                for x in 0..<w {
                    let o = y * rowBytes + x * 2
                    let b0 = UInt16(raw[o]), b1 = UInt16(raw[o + 1])
                    values[y * w + x] = little ? (b0 | b1 << 8) : (b0 << 8 | b1)
                }
            }
        }
        return (w, h, values)
    }
}
