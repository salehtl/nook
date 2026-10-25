// Draws the nook-scan app icon: a room corner with scan points inside viewfinder brackets.
// 1024 × 1024 PNG, opaque (App Store icons must not have alpha).
// Usage: swift ios/scripts/make_icon.swift [out.png]
//   default out: ios/NookScan/Assets.xcassets/AppIcon.appiconset/AppIcon.png
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let scriptDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let out = CommandLine.arguments.count > 1
    ? URL(fileURLWithPath: CommandLine.arguments[1])
    : scriptDir.appendingPathComponent("../NookScan/Assets.xcassets/AppIcon.appiconset/AppIcon.png").standardized

let space = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fatalError("no context") }
// Top-left origin, y down.
ctx.translateBy(x: 0, y: CGFloat(size))
ctx.scaleBy(x: 1, y: -1)

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(colorSpace: space, components: [CGFloat((hex >> 16) & 0xff) / 255, CGFloat((hex >> 8) & 0xff) / 255,
                                            CGFloat(hex & 0xff) / 255, a])!
}

// Background: deep teal gradient.
let bg = CGGradient(colorsSpace: space, colors: [rgb(0x24474A), rgb(0x0E1D22)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(bg, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: size), options: [])

// Room corner in isometric view.
let corner = CGPoint(x: 512, y: 590)
let top = CGPoint(x: 512, y: 250)
let left = CGPoint(x: 232, y: 750)
let right = CGPoint(x: 792, y: 750)
let dx = CGPoint(x: left.x - corner.x, y: left.y - corner.y)   // floor axis to the left
let dz = CGPoint(x: right.x - corner.x, y: right.y - corner.y) // floor axis to the right
let up = CGPoint(x: 0, y: top.y - corner.y)

func path(_ pts: [CGPoint]) -> CGPath {
    let p = CGMutablePath()
    p.addLines(between: pts)
    p.closeSubpath()
    return p
}

// Walls and floor, softly filled.
ctx.addPath(path([corner, top, CGPoint(x: left.x, y: left.y + up.y), left]))
ctx.setFillColor(rgb(0xF3E9DA, 0.08)); ctx.fillPath()
ctx.addPath(path([corner, top, CGPoint(x: right.x, y: right.y + up.y), right]))
ctx.setFillColor(rgb(0xF3E9DA, 0.13)); ctx.fillPath()
let floorFar = CGPoint(x: left.x + dz.x, y: left.y + dz.y)
ctx.addPath(path([corner, left, floorFar, right]))
ctx.setFillColor(rgb(0xE8B872, 0.16)); ctx.fillPath()

// Scan points on the floor and walls: an amber lattice that fades with distance from the corner.
func dot(_ p: CGPoint, _ r: CGFloat, _ a: CGFloat) {
    ctx.setFillColor(rgb(0xF5B95F, a))
    ctx.fillEllipse(in: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r))
}
let n = 7
for i in 1..<n {
    for j in 1..<n {
        let u = CGFloat(i) / CGFloat(n), v = CGFloat(j) / CGFloat(n)
        let p = CGPoint(x: corner.x + dx.x * u + dz.x * v, y: corner.y + dx.y * u + dz.y * v)
        dot(p, 11, 0.95 - 0.5 * (u + v) / 2)
    }
    for j in 1..<n {
        let u = CGFloat(i) / CGFloat(n), v = CGFloat(j) / CGFloat(n)
        let a = 0.55 - 0.35 * (u + v) / 2
        dot(CGPoint(x: corner.x + dx.x * u, y: corner.y + dx.y * u + up.y * v), 8, a)
        dot(CGPoint(x: corner.x + dz.x * u, y: corner.y + dz.y * u + up.y * v), 8, a)
    }
}

// Corner edges.
ctx.setStrokeColor(rgb(0xF3E9DA))
ctx.setLineWidth(22)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.move(to: top); ctx.addLine(to: corner); ctx.addLine(to: left)
ctx.move(to: corner); ctx.addLine(to: right)
ctx.strokePath()

// Viewfinder brackets.
let m: CGFloat = 132, len: CGFloat = 150
ctx.setStrokeColor(rgb(0xF3E9DA, 0.9))
ctx.setLineWidth(26)
for (x, y, sx, sy) in [(m, m, 1.0, 1.0), (CGFloat(size) - m, m, -1.0, 1.0), (m, CGFloat(size) - m, 1.0, -1.0),
                       (CGFloat(size) - m, CGFloat(size) - m, -1.0, -1.0)] {
    ctx.move(to: CGPoint(x: x, y: y + sy * len))
    ctx.addLine(to: CGPoint(x: x, y: y))
    ctx.addLine(to: CGPoint(x: x + sx * len, y: y))
}
ctx.strokePath()

guard let image = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("cannot create \(out.path)")
}
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("cannot write \(out.path)") }
print("wrote \(out.path) (\(size)x\(size))")
