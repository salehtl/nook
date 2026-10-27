import SwiftUI

/// One frame of a guide's looping animation at `time` seconds: a top-down room plan, plus a side-view close-up of
/// the phone for the passes. Drawn with Canvas so it renders the same on screen and in ImageRenderer (tests).
struct GuideScene: View {
    let guide: ScanGuide
    let time: Double
    /// The strip during capture: just the room plan, no close-up.
    var compact = false

    static let period = 6.0

    var body: some View {
        Canvas { ctx, size in
            let t = (time / Self.period).truncatingRemainder(dividingBy: 1)
            let showCloseUp = !compact && [.pass1, .pass2, .pass3].contains(guide)
            let planRect: CGRect
            if showCloseUp {
                planRect = CGRect(x: 0, y: 0, width: size.width * 0.62, height: size.height).insetBy(dx: 6, dy: 6)
                let close = CGRect(x: size.width * 0.64, y: 0, width: size.width * 0.36, height: size.height).insetBy(dx: 4, dy: 6)
                drawCloseUp(&ctx, in: close, t: t)
            } else {
                planRect = CGRect(origin: .zero, size: size).insetBy(dx: compact ? 2 : 6, dy: compact ? 2 : 6)
            }
            switch guide {
            case .prepare: drawPrepare(&ctx, in: planRect, t: t)
            case .lockLight: drawLock(&ctx, in: planRect, t: t)
            case .pass1, .pass2, .pass3: drawPass(&ctx, in: planRect, t: t)
            case .roomShell: drawShell(&ctx, in: planRect, t: t)
            }
        }
        .accessibilityLabel(guide.title)
    }

    // MARK: Room plan

    private func roomRect(in r: CGRect) -> CGRect {
        let side = min(r.width, r.height * 1.25)
        let w = side, h = side * 0.8
        return CGRect(x: r.midX - w / 2, y: r.midY - h / 2, width: w, height: h).insetBy(dx: 4, dy: 4)
    }

    private func drawRoom(_ ctx: inout GraphicsContext, _ room: CGRect) {
        let lw = max(2, room.width * 0.025)
        ctx.fill(Path(roundedRect: room, cornerRadius: 4), with: .color(.secondary.opacity(0.12)))
        ctx.stroke(Path(roundedRect: room, cornerRadius: 4), with: .color(.primary.opacity(0.75)), lineWidth: lw)
        // A window in the top wall.
        let win = CGRect(x: room.midX - room.width * 0.15, y: room.minY - lw, width: room.width * 0.3, height: lw * 2)
        ctx.fill(Path(win), with: .color(.cyan))
    }

    private func drawPhone(_ ctx: inout GraphicsContext, at p: CGPoint, heading: Double, scale: CGFloat, coneColor: Color = .yellow) {
        // View cone toward `heading` (radians, 0 = up the screen, clockwise).
        let len = scale * 3.2, half = 0.45
        var cone = Path()
        cone.move(to: p)
        cone.addLine(to: CGPoint(x: p.x + len * sin(heading - half), y: p.y - len * cos(heading - half)))
        cone.addLine(to: CGPoint(x: p.x + len * sin(heading + half), y: p.y - len * cos(heading + half)))
        cone.closeSubpath()
        ctx.fill(cone, with: .color(coneColor.opacity(0.35)))
        let dot = CGRect(x: p.x - scale / 2, y: p.y - scale / 2, width: scale, height: scale)
        ctx.fill(Path(ellipseIn: dot), with: .color(.accentColor))
        ctx.stroke(Path(ellipseIn: dot), with: .color(.white), lineWidth: max(1, scale * 0.12))
    }

    /// A point on the loop `inset` inside the room, `u` ∈ [0, 1) around it (clockwise from the top-left).
    private func loopPoint(_ room: CGRect, inset: CGFloat, u: Double) -> CGPoint {
        let r = room.insetBy(dx: inset, dy: inset)
        let per = 2 * (r.width + r.height)
        var d = CGFloat(u) * per
        if d < r.width { return CGPoint(x: r.minX + d, y: r.minY) }
        d -= r.width
        if d < r.height { return CGPoint(x: r.maxX, y: r.minY + d) }
        d -= r.height
        if d < r.width { return CGPoint(x: r.maxX - d, y: r.maxY) }
        d -= r.width
        return CGPoint(x: r.minX, y: r.maxY - d)
    }

    private func heading(from p: CGPoint, to q: CGPoint) -> Double {
        atan2(Double(q.x - p.x), Double(p.y - q.y))
    }

    private func drawPass(_ ctx: inout GraphicsContext, in r: CGRect, t: Double) {
        let room = roomRect(in: r)
        drawRoom(&ctx, room)
        let s = room.width * 0.07
        let center = CGPoint(x: room.midX, y: room.midY)
        // The walked path, faint, then the phone on it.
        var path = Path()
        let p: CGPoint, h: Double
        switch guide {
        case .pass3:
            let a = CGPoint(x: room.minX + room.width * 0.15, y: room.midY + room.height * 0.12)
            let b = CGPoint(x: room.maxX - room.width * 0.15, y: room.midY - room.height * 0.12)
            path.move(to: a); path.addLine(to: b)
            let u = t < 0.5 ? t * 2 : 2 - t * 2
            p = CGPoint(x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u)
            h = t * 4 * .pi   // turns to face each wall
        default:
            let inset = room.width * (guide == .pass1 ? 0.12 : 0.2)
            for i in 0...64 {
                let q = loopPoint(room, inset: inset, u: Double(i) / 64)
                if i == 0 { path.move(to: q) } else { path.addLine(to: q) }
            }
            p = loopPoint(room, inset: inset, u: t)
            h = heading(from: p, to: center)   // looking across the room
        }
        ctx.stroke(path, with: .color(.accentColor.opacity(0.35)), style: StrokeStyle(lineWidth: max(1.5, s * 0.25), dash: [s * 0.4, s * 0.3]))
        drawPhone(&ctx, at: p, heading: h, scale: s, coneColor: guide == .pass2 ? .orange : .yellow)
    }

    private func drawPrepare(_ ctx: inout GraphicsContext, in r: CGRect, t: Double) {
        let room = roomRect(in: r)
        drawRoom(&ctx, room)
        // Soft daylight from the window (no harsh patch).
        let glow = CGRect(x: room.midX - room.width * 0.3, y: room.minY, width: room.width * 0.6, height: room.height * 0.55)
        ctx.fill(Path(ellipseIn: glow), with: .radialGradient(Gradient(colors: [.yellow.opacity(0.35), .clear]),
                                                               center: CGPoint(x: glow.midX, y: glow.minY), startRadius: 0, endRadius: glow.height))
        // A cupboard on the left wall whose door swings shut, then a tick.
        let cw = room.width * 0.1, chh = room.height * 0.3
        let cup = CGRect(x: room.minX + 3, y: room.midY - chh / 2, width: cw, height: chh)
        ctx.fill(Path(cup), with: .color(.brown.opacity(0.6)))
        let close = min(1, max(0, (t - 0.15) / 0.4))
        let angle = (1 - close) * 1.2
        var door = Path()
        let hinge = CGPoint(x: cup.maxX, y: cup.minY)
        door.move(to: hinge)
        door.addLine(to: CGPoint(x: hinge.x + chh * sin(angle), y: hinge.y + chh * cos(angle)))
        ctx.stroke(door, with: .color(.brown), lineWidth: max(2, cw * 0.3))
        // Tidied cable: a squiggle on the floor straightening into the wall.
        var cable = Path()
        let y0 = room.maxY - room.height * 0.12
        for i in 0...20 {
            let x = room.midX + room.width * 0.05 + CGFloat(i) / 20 * room.width * 0.35
            let y = y0 + (1 - close) * sin(Double(i) * 1.3) * room.height * 0.05
            if i == 0 { cable.move(to: CGPoint(x: x, y: y)) } else { cable.addLine(to: CGPoint(x: x, y: y)) }
        }
        ctx.stroke(cable, with: .color(.primary.opacity(0.6)), lineWidth: 2)
        if close >= 1 { drawTick(&ctx, at: CGPoint(x: room.maxX - room.width * 0.12, y: room.minY + room.height * 0.2), size: room.width * 0.1) }
    }

    private func drawLock(_ ctx: inout GraphicsContext, in r: CGRect, t: Double) {
        let room = roomRect(in: r)
        drawRoom(&ctx, room)
        // The phone near the bottom wall, facing a typical part of the room (not the window at the top).
        let s = room.width * 0.08
        let p = CGPoint(x: room.minX + room.width * 0.3, y: room.maxY - room.height * 0.2)
        let target = CGPoint(x: room.maxX, y: room.midY)
        drawPhone(&ctx, at: p, heading: heading(from: p, to: target), scale: s)
        // A second passes, then the lock shows.
        let locked = t > 0.3
        let badge = CGRect(x: room.midX - room.width * 0.2, y: room.minY + room.height * 0.25, width: room.width * 0.4, height: room.height * 0.2)
        ctx.fill(Path(roundedRect: badge, cornerRadius: badge.height / 2), with: .color(.black.opacity(0.6)))
        let symbol = ctx.resolve(Image(systemName: locked ? "lock.fill" : "lock.open"))
        let ring = CGRect(x: badge.minX + badge.height * 0.2, y: badge.minY + badge.height * 0.2, width: badge.height * 0.6, height: badge.height * 0.6)
        var c = ctx
        c.addFilter(.colorMultiply(locked ? .yellow : .white))
        c.draw(symbol, in: ring)
        if !locked {
            // A countdown arc while it settles.
            let arc = Path { p in
                p.addArc(center: CGPoint(x: badge.maxX - badge.height * 0.5, y: badge.midY), radius: badge.height * 0.28,
                         startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * t / 0.3), clockwise: false)
            }
            ctx.stroke(arc, with: .color(.white), lineWidth: 2.5)
        } else {
            drawTick(&ctx, at: CGPoint(x: badge.maxX - badge.height * 0.5, y: badge.midY), size: badge.height * 0.55)
        }
    }

    /// The phone stays put and sweeps round; each wall turns green once the view has passed over it.
    private func drawShell(_ ctx: inout GraphicsContext, in r: CGRect, t: Double) {
        let room = roomRect(in: r)
        drawRoom(&ctx, room)
        let p = CGPoint(x: room.midX - room.width * 0.1, y: room.midY + room.height * 0.1)
        let sweep = min(1, t / 0.8) * 2 * .pi   // one slow turn, then a pause with the shell complete
        let lw = max(3, room.width * 0.035)
        // Walls clockwise from the top, each at the heading (0 = up) where the view meets its middle.
        let walls: [(CGPoint, CGPoint)] = [
            (CGPoint(x: room.minX, y: room.minY), CGPoint(x: room.maxX, y: room.minY)),
            (CGPoint(x: room.maxX, y: room.minY), CGPoint(x: room.maxX, y: room.maxY)),
            (CGPoint(x: room.maxX, y: room.maxY), CGPoint(x: room.minX, y: room.maxY)),
            (CGPoint(x: room.minX, y: room.maxY), CGPoint(x: room.minX, y: room.minY)),
        ]
        for (a, b) in walls {
            let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
            var h = heading(from: p, to: mid)
            if h < 0 { h += 2 * .pi }
            guard sweep >= h else { continue }
            var wall = Path(); wall.move(to: a); wall.addLine(to: b)
            ctx.stroke(wall, with: .color(.green), lineWidth: lw)
        }
        drawPhone(&ctx, at: p, heading: sweep, scale: room.width * 0.07, coneColor: .green)
        if t >= 0.8 { drawTick(&ctx, at: CGPoint(x: room.maxX - room.width * 0.15, y: room.minY + room.height * 0.2), size: room.width * 0.1) }
    }

    private func drawTick(_ ctx: inout GraphicsContext, at c: CGPoint, size: CGFloat) {
        var p = Path()
        p.move(to: CGPoint(x: c.x - size * 0.4, y: c.y))
        p.addLine(to: CGPoint(x: c.x - size * 0.1, y: c.y + size * 0.3))
        p.addLine(to: CGPoint(x: c.x + size * 0.45, y: c.y - size * 0.35))
        ctx.stroke(p, with: .color(.green), style: StrokeStyle(lineWidth: max(2, size * 0.18), lineCap: .round, lineJoin: .round))
    }

    // MARK: Close-up (side view)

    /// A person by a wall holding the phone: chest height and level (passes 1 and 3), or lower and tilted down at the
    /// floor and skirting (pass 2). Pass 3 also turns.
    private func drawCloseUp(_ ctx: inout GraphicsContext, in r: CGRect, t: Double) {
        ctx.fill(Path(roundedRect: r, cornerRadius: 8), with: .color(.secondary.opacity(0.1)))
        let floorY = r.maxY - r.height * 0.1
        var floor = Path(); floor.move(to: CGPoint(x: r.minX + 4, y: floorY)); floor.addLine(to: CGPoint(x: r.maxX - 4, y: floorY))
        ctx.stroke(floor, with: .color(.primary.opacity(0.6)), lineWidth: 2)
        let wallX = r.maxX - r.width * 0.08
        var wall = Path(); wall.move(to: CGPoint(x: wallX, y: r.minY + r.height * 0.08)); wall.addLine(to: CGPoint(x: wallX, y: floorY))
        ctx.stroke(wall, with: .color(.primary.opacity(0.6)), lineWidth: 2)
        // Skirting board.
        ctx.fill(Path(CGRect(x: wallX - 4, y: floorY - r.height * 0.05, width: 4, height: r.height * 0.05)), with: .color(.primary.opacity(0.5)))

        let tall = r.height * 0.78
        let footX = r.minX + r.width * 0.3
        let headR = tall * 0.07
        let headC = CGPoint(x: footX, y: floorY - tall + headR)
        ctx.stroke(Path(ellipseIn: CGRect(x: headC.x - headR, y: headC.y - headR, width: headR * 2, height: headR * 2)),
                   with: .color(.primary), lineWidth: 2)
        var body = Path()
        body.move(to: CGPoint(x: footX, y: headC.y + headR)); body.addLine(to: CGPoint(x: footX, y: floorY - tall * 0.45))
        body.move(to: CGPoint(x: footX, y: floorY - tall * 0.45)); body.addLine(to: CGPoint(x: footX - tall * 0.08, y: floorY))
        body.move(to: CGPoint(x: footX, y: floorY - tall * 0.45)); body.addLine(to: CGPoint(x: footX + tall * 0.08, y: floorY))
        ctx.stroke(body, with: .color(.primary), lineWidth: 2)

        let low = guide == .pass2
        let bob = sin(t * 2 * .pi * 2) * Double(tall) * 0.01
        let phoneY = floorY - tall * (low ? 0.5 : 0.7) + CGFloat(bob)
        let phoneX = footX + tall * 0.17
        var arm = Path(); arm.move(to: CGPoint(x: footX, y: floorY - tall * 0.72)); arm.addLine(to: CGPoint(x: phoneX, y: phoneY))
        ctx.stroke(arm, with: .color(.primary), lineWidth: 2)
        // Tilt, radians below level: pass 2 about 35° down; pass 3 sways as it turns.
        let tilt = low ? 0.6 : (guide == .pass3 ? 0.08 * sin(t * 4 * .pi) : 0)
        var phone = ctx
        phone.translateBy(x: phoneX, y: phoneY)
        phone.rotate(by: .radians(tilt))
        let pw = tall * 0.04, ph = tall * 0.13
        phone.fill(Path(roundedRect: CGRect(x: -pw / 2, y: -ph / 2, width: pw, height: ph), cornerRadius: 2), with: .color(.accentColor))
        // View rays from the phone (screen angles: positive is down), to the wall or the floor, whichever is nearer.
        for spread in [-0.3, 0.0, 0.3] {
            let a = tilt + spread
            let dx = cos(a), dy = sin(a)
            var reach = Double(wallX - phoneX) / dx
            if dy > 0 { reach = min(reach, Double(floorY - phoneY) / dy) }
            var ray = Path()
            ray.move(to: CGPoint(x: phoneX, y: phoneY))
            ray.addLine(to: CGPoint(x: phoneX + CGFloat(dx * reach), y: phoneY + CGFloat(dy * reach)))
            ctx.stroke(ray, with: .color((low ? Color.orange : Color.yellow).opacity(0.8)), style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
        }
    }
}

/// A guide's animation, looping (or still, with Reduce Motion).
struct LoopingGuideScene: View {
    let guide: ScanGuide
    var compact = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            GuideScene(guide: guide, time: GuideScene.period * 0.6, compact: compact)
        } else {
            TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                GuideScene(guide: guide, time: context.date.timeIntervalSinceReferenceDate, compact: compact)
            }
        }
    }
}
