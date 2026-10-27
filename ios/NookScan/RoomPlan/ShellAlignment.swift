import Foundation
import simd

/// A vertical plane: a point on it, its horizontal unit normal (the sign doesn't matter) and its width in meters,
/// which weights it. RoomPlan walls and the capture's ARKit vertical plane anchors both become these.
struct WallPlane: Equatable {
    var center: SIMD3<Float>
    var normal: SIMD3<Float>
    var width: Float

    init(center: SIMD3<Float>, normal: SIMD3<Float>, width: Float) {
        let h = SIMD3<Float>(normal.x, 0, normal.z)
        self.center = center
        self.normal = simd_length(h) > 0 ? simd_normalize(h) : SIMD3(0, 0, 1)
        self.width = width
    }

    /// From a plane's transform: `normalColumn` is the local axis the plane faces (2 for a RoomPlan wall, whose
    /// local XY is the wall; 1 for an ARKit plane anchor, whose local XZ is the plane).
    init(transform m: simd_float4x4, width: Float, normalColumn: Int) {
        let n = m[normalColumn]
        self.init(center: SIMD3(m.columns.3.x, m.columns.3.y, m.columns.3.z), normal: SIMD3(n.x, n.y, n.z), width: width)
    }

    /// Heading of the normal, radians: atan2(x, z), so a turn by θ about +Y adds θ.
    var angle: Double { atan2(Double(normal.x), Double(normal.z)) }
}

/// Solves `world_from_roomplan` for a separate RoomPlan session (contract §4.12).
///
/// Both ARKit sessions are gravity-aligned, so the transform is a turn about +Y plus a shift: four numbers.
/// - **Height:** the capture's floor (`meta.floor_y`, from ARKit's horizontal planes) minus RoomPlan's floor surface.
/// - **Yaw, up to 90°:** rooms are mostly square-cornered, so both wall sets have one dominant direction modulo 90°
///   (a weighted histogram, refined by a circular mean of the walls near its peak). Their difference leaves four
///   candidate yaws, 90° apart.
/// - **Shift, per candidate:** along each of the two wall directions, every RoomPlan wall and capture plane facing
///   that way gives a candidate offset; the one that lines up the most wall width within 8 cm wins (a vote, so
///   cupboard fronts and other non-wall planes are outvoted), then the matched pairs are averaged. The yaw is refined
///   from the matched pairs' angles and the shift solved again.
/// - **Choosing the candidate:** the one lining up the most wall width. A rectangular room looks the same turned
///   180°, so among candidates within 80 % of the best, the one closest to the `prior` wins: where the phone was at
///   the end of the photo passes versus where RoomPlan's session started (the phone barely moves in between).
///
/// It fails, rather than guessing, when walls in two directions can't be matched.
enum ShellAlignment {
    static let tolerance: Double = 0.08          // m, a wall and a plane line up
    static let axisCos = cos(10 * Double.pi / 180)   // a plane faces an axis within 10°
    static let minCaptureWidth: Float = 0.3      // m, smaller capture planes are ignored

    struct Solution: Equatable {
        var worldFromRoomplan: simd_float4x4
        /// Radians.
        var yaw: Double
        var offset: SIMD3<Double>
        /// RoomPlan walls lined up with a capture plane.
        var matchedWalls: Int
        /// RMS distance between matched walls and planes along their normals, meters.
        var residual: Double
    }

    enum Failure: LocalizedError, Equatable {
        case noWalls
        case noFloor
        case oneDirection

        var errorDescription: String? {
            switch self {
            case .noWalls: "The room shell has no walls, or the scan saw none to line it up with."
            case .noFloor: "The room shell has no floor to line up."
            case .oneDirection: "Couldn't line the room shell up with the scan: walls in two directions are needed."
            }
        }
    }

    /// `prior`: a rough capture-world-from-RoomPlan transform (see `prior(captureEnd:roomplanStart:)`), used only to
    /// pick between look-alike candidates and as the height when the capture has no floor.
    static func solve(roomplanWalls: [WallPlane], roomplanFloorY: Float?, captureWalls: [WallPlane], captureFloorY: Float?,
                      prior: simd_float4x4? = nil) throws(Failure) -> Solution {
        let rp = roomplanWalls.filter { $0.width > 0 }
        let cap = captureWalls.filter { $0.width >= minCaptureWidth }
        guard !rp.isEmpty, !cap.isEmpty else { throw .noWalls }
        guard let rpFloor = roomplanFloorY else { throw .noFloor }
        let ty: Double
        if let captureFloorY {
            ty = Double(captureFloorY) - Double(rpFloor)
        } else if let prior {
            ty = Double(prior.columns.3.y)
        } else {
            throw .noFloor
        }

        let phiCap = dominantAngle(cap), phiRP = dominantAngle(rp)
        let priorYaw = prior.map(yaw(of:))
        let priorShift = prior.map { SIMD2(Double($0.columns.3.x), Double($0.columns.3.z)) }

        var candidates: [Candidate] = []
        for k in 0..<4 {
            var theta = phiCap - phiRP + Double(k) * .pi / 2
            var c = evaluate(theta: theta, rp: rp, cap: cap, phi: phiCap)
            for _ in 0..<3 where c.pairs.count > 0 {
                theta += c.angleCorrection
                c = evaluate(theta: theta, rp: rp, cap: cap, phi: phiCap)
            }
            candidates.append(c)
        }
        let valid = candidates.filter(\.bothAxes)
        guard let best = valid.max(by: { $0.score < $1.score }) else { throw .oneDirection }
        var pick = best
        if let priorYaw, let priorShift {
            let near = valid.filter { $0.score >= 0.8 * best.score }
            pick = near.min { cost($0, priorYaw, priorShift) < cost($1, priorYaw, priorShift) } ?? best
        }

        let theta = wrapPi(pick.theta)
        let m = matrix(yaw: theta, shift: SIMD3(pick.shift.x, ty, pick.shift.y))
        return Solution(worldFromRoomplan: m, yaw: theta, offset: SIMD3(pick.shift.x, ty, pick.shift.y),
                        matchedWalls: Set(pick.pairs.map(\.rp)).count, residual: pick.residual)
    }

    /// Capture world from RoomPlan world if the phone didn't move between the end of the capture (`captureEnd`, its
    /// last camera pose) and the start of RoomPlan's session (`roomplanStart`): the yaw that best turns one camera
    /// orientation into the other, and the shift that puts one camera position on the other.
    static func prior(captureEnd: simd_float4x4, roomplanStart: simd_float4x4) -> simd_float4x4 {
        // R = Rcap · Rrpᵀ should be a pure turn about Y; its closest one is atan2(R02 − R20, R00 + R22).
        let a = simd_float3x3(captureEnd[0].xyz, captureEnd[1].xyz, captureEnd[2].xyz)
        let b = simd_float3x3(roomplanStart[0].xyz, roomplanStart[1].xyz, roomplanStart[2].xyz)
        let r = a * b.transpose
        let theta = atan2(Double(r[2][0] - r[0][2]), Double(r[0][0] + r[2][2]))
        let p = SIMD3<Double>(Double(roomplanStart.columns.3.x), Double(roomplanStart.columns.3.y), Double(roomplanStart.columns.3.z))
        let q = SIMD3<Double>(Double(captureEnd.columns.3.x), Double(captureEnd.columns.3.y), Double(captureEnd.columns.3.z))
        return matrix(yaw: theta, shift: q - rotate(p, theta))
    }

    /// A turn by `yaw` about +Y, then a shift. Row-major: [[c,0,s,x],[0,1,0,y],[−s,0,c,z],[0,0,0,1]].
    static func matrix(yaw: Double, shift t: SIMD3<Double>) -> simd_float4x4 {
        let c = Float(cos(yaw)), s = Float(sin(yaw))
        return simd_float4x4(columns: (SIMD4(c, 0, -s, 0), SIMD4(0, 1, 0, 0), SIMD4(s, 0, c, 0),
                                       SIMD4(Float(t.x), Float(t.y), Float(t.z), 1)))
    }

    /// The turn about +Y in a (nearly) yaw-only transform, radians.
    static func yaw(of m: simd_float4x4) -> Double {
        atan2(Double(m[2][0] - m[0][2]), Double(m[0][0] + m[2][2]))
    }

    // MARK: Internals

    private struct Pair { let rp: Int; let cap: Int; let weight: Double; let gap: Double; let angle: Double }

    private struct Candidate {
        var theta: Double
        var shift: SIMD2<Double>    // x, z
        var score: Double           // matched wall width, m
        var bothAxes: Bool
        var pairs: [Pair]
        var residual: Double
        var angleCorrection: Double
    }

    private static func cost(_ c: Candidate, _ priorYaw: Double, _ priorShift: SIMD2<Double>) -> Double {
        abs(wrapPi(c.theta - priorYaw)) / (.pi / 4) + simd_length(c.shift - priorShift)
    }

    private static func rotate(_ p: SIMD3<Double>, _ theta: Double) -> SIMD3<Double> {
        let c = cos(theta), s = sin(theta)
        return SIMD3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z)
    }

    private static func dvec(_ v: SIMD3<Float>) -> SIMD3<Double> { SIMD3(Double(v.x), Double(v.y), Double(v.z)) }

    /// x wrapped into [−π, π).
    static func wrapPi(_ x: Double) -> Double {
        var y = fmod(x + .pi, 2 * .pi)
        if y < 0 { y += 2 * .pi }
        return y - .pi
    }

    /// x wrapped into [−p/2, p/2).
    private static func wrap(_ x: Double, period p: Double) -> Double {
        var y = fmod(x + p / 2, p)
        if y < 0 { y += p }
        return y - p / 2
    }

    /// The direction the walls mostly face, modulo 90°: the peak of a width-weighted 1° histogram (smoothed ±3°),
    /// refined by the weighted mean of the walls within 6° of it.
    static func dominantAngle(_ planes: [WallPlane]) -> Double {
        let quarter = Double.pi / 2, bins = 90
        var hist = [Double](repeating: 0, count: bins)
        for p in planes {
            var a = fmod(p.angle, quarter); if a < 0 { a += quarter }
            hist[min(bins - 1, Int(a / quarter * Double(bins)))] += Double(p.width)
        }
        var bestBin = 0, bestScore = -1.0
        for b in 0..<bins {
            let s = (-3...3).reduce(0.0) { $0 + hist[((b + $1) % bins + bins) % bins] }
            if s > bestScore { bestScore = s; bestBin = b }
        }
        let peak = (Double(bestBin) + 0.5) / Double(bins) * quarter
        var sum = 0.0, wsum = 0.0
        for p in planes {
            let d = wrap(p.angle - peak, period: quarter)
            guard abs(d) < 6 * .pi / 180 else { continue }
            sum += Double(p.width) * d; wsum += Double(p.width)
        }
        return wsum > 0 ? peak + sum / wsum : peak
    }

    /// For one yaw: rotate the RoomPlan walls, then vote for the shift along each of the two wall directions.
    private static func evaluate(theta: Double, rp: [WallPlane], cap: [WallPlane], phi: Double) -> Candidate {
        let axes = [SIMD3<Double>(sin(phi), 0, cos(phi)), SIMD3<Double>(cos(phi), 0, -sin(phi))]
        let rpN = rp.map { rotate(dvec($0.normal), theta) }
        let rpC = rp.map { rotate(dvec($0.center), theta) }
        var shift2 = [0.0, 0.0], score = 0.0, both = true
        var pairs: [Pair] = []
        for (ai, a) in axes.enumerated() {
            let ri = rp.indices.filter { abs(simd_dot(rpN[$0], a)) > axisCos }
            let ci = cap.indices.filter { abs(simd_dot(dvec(cap[$0].normal), a)) > axisCos }
            guard !ri.isEmpty, !ci.isEmpty else { both = false; continue }
            let d = Dictionary(uniqueKeysWithValues: ri.map { ($0, simd_dot(rpC[$0], a)) })
            let e = Dictionary(uniqueKeysWithValues: ci.map { ($0, simd_dot(dvec(cap[$0].center), a)) })
            // Each wall's best match for a shift: the nearest plane within tolerance.
            func matches(_ s: Double) -> [(Int, Int, Double)] {
                ri.compactMap { i in
                    let best = ci.min { abs(d[i]! + s - e[$0]!) < abs(d[i]! + s - e[$1]!) }!
                    let gap = e[best]! - d[i]! - s
                    return abs(gap) < tolerance ? (i, best, gap) : nil
                }
            }
            func votes(_ s: Double) -> Double {
                matches(s).reduce(0) { $0 + Double(min(rp[$1.0].width, max(cap[$1.1].width, 0.5))) }
            }
            var bestS = 0.0, bestV = -1.0
            for i in ri { for j in ci {
                let s = e[j]! - d[i]!, v = votes(s)
                if v > bestV + 1e-9 { bestV = v; bestS = s }
            } }
            guard bestV > 0 else { both = false; continue }
            // Refine: the weighted mean shift of the matched pairs (twice, as matches can change a little).
            var s = bestS
            for _ in 0..<2 {
                let m = matches(s)
                let w = m.map { Double(rp[$0.0].width) }
                let total = w.reduce(0, +)
                guard total > 0 else { break }
                s += zip(m, w).reduce(0) { $0 + $1.0.2 * $1.1 } / total
            }
            let m = matches(s)
            score += votes(s)
            shift2[ai] = s
            for (i, j, gap) in m {
                let da = wrap(cap[j].angle - atan2(rpN[i].x, rpN[i].z), period: .pi)
                pairs.append(Pair(rp: i, cap: j, weight: Double(rp[i].width), gap: gap, angle: da))
            }
        }
        let shift = SIMD2(axes[0].x * shift2[0] + axes[1].x * shift2[1], axes[0].z * shift2[0] + axes[1].z * shift2[1])
        let wsum = pairs.reduce(0) { $0 + $1.weight }
        let residual = wsum > 0 ? (pairs.reduce(0) { $0 + $1.weight * $1.gap * $1.gap } / wsum).squareRoot() : .infinity
        let correction = wsum > 0 ? pairs.reduce(0) { $0 + $1.weight * $1.angle } / wsum : 0
        return Candidate(theta: theta, shift: shift, score: score, bothAxes: both, pairs: pairs, residual: residual,
                         angleCorrection: correction)
    }
}
