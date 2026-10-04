"""Geometry helpers: clipping to a rectangle, simplification, quantization.

All functions work on lists of (x, y) float tuples. Clipping and area work in
any planar unit; the pipeline uses local metres (see Projector).
"""

import math

from catalog import M_PER_DEG


class Projector:
    """Local equirectangular projection around the centre latitude of a view.

    x metres = (lon - west) * M_PER_DEG * cos(centre latitude)
    y metres = (lat - south) * M_PER_DEG        (y grows north)
    """

    def __init__(self, bounds, quant):
        self.w, self.s, self.e, self.n = bounds
        lat_c = (self.s + self.n) / 2
        self.kx = M_PER_DEG * math.cos(math.radians(lat_c))
        self.ky = M_PER_DEG
        self.width_m = (self.e - self.w) * self.kx
        self.height_m = (self.n - self.s) * self.ky
        self.quant = quant
        self.qx = quant / self.width_m
        self.qy = quant / self.height_m

    def to_m(self, lon, lat):
        return ((lon - self.w) * self.kx, (lat - self.s) * self.ky)

    def rect(self):
        return (0.0, 0.0, self.width_m, self.height_m)

    def quantize(self, pts):
        """Metres -> integer grid 0..quant on both axes; drops repeated points."""
        q = self.quant
        out = []
        last = None
        for x, y in pts:
            p = (min(q, max(0, round(x * self.qx))), min(q, max(0, round(y * self.qy))))
            if p != last:
                out.append(p)
                last = p
        return out


# ---------------------------------------------------------------- clipping


def clip_polyline(pts, rect):
    """Liang–Barsky clip of a polyline to rect=(x0,y0,x1,y1). Returns pieces."""
    x0, y0, x1, y1 = rect
    pieces = []
    cur = []
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        dx, dy = bx - ax, by - ay
        t0, t1 = 0.0, 1.0
        ok = True
        for p, q in ((-dx, ax - x0), (dx, x1 - ax), (-dy, ay - y0), (dy, y1 - ay)):
            if p == 0:
                if q < 0:
                    ok = False
                    break
            else:
                r = q / p
                if p < 0:
                    if r > t1:
                        ok = False
                        break
                    if r > t0:
                        t0 = r
                else:
                    if r < t0:
                        ok = False
                        break
                    if r < t1:
                        t1 = r
        if not ok:
            if cur:
                pieces.append(cur)
                cur = []
            continue
        sa = (ax + t0 * dx, ay + t0 * dy) if t0 > 0 else (ax, ay)
        sb = (ax + t1 * dx, ay + t1 * dy) if t1 < 1 else (bx, by)
        if not cur:
            cur = [sa]
        elif t0 > 0:  # re-entered: start a new piece
            pieces.append(cur)
            cur = [sa]
        cur.append(sb)
        if t1 < 1:
            pieces.append(cur)
            cur = []
    if cur:
        pieces.append(cur)
    return [p for p in pieces if len(p) >= 2]


def clip_ring(ring, rect):
    """Sutherland–Hodgman clip of a closed ring (no repeated closing point)."""
    x0, y0, x1, y1 = rect
    out = ring
    for edge in range(4):
        if not out:
            break
        inp = out
        out = []

        def inside(p):
            if edge == 0:
                return p[0] >= x0
            if edge == 1:
                return p[0] <= x1
            if edge == 2:
                return p[1] >= y0
            return p[1] <= y1

        def cross(a, b):
            if edge < 2:
                xe = x0 if edge == 0 else x1
                t = (xe - a[0]) / (b[0] - a[0])
                return (xe, a[1] + t * (b[1] - a[1]))
            ye = y0 if edge == 2 else y1
            t = (ye - a[1]) / (b[1] - a[1])
            return (a[0] + t * (b[0] - a[0]), ye)

        prev = inp[-1]
        pin = inside(prev)
        for cur in inp:
            cin = inside(cur)
            if cin:
                if not pin:
                    out.append(cross(prev, cur))
                out.append(cur)
            elif pin:
                out.append(cross(prev, cur))
            prev, pin = cur, cin
    return out


def ring_area(ring):
    """Signed shoelace area; positive = counter-clockwise (y up)."""
    a = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2


def line_length(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))


def bbox_of(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


# ---------------------------------------------------------------- simplification


def simplify(pts, tol):
    """Douglas–Peucker, iterative. Keeps first and last point."""
    n = len(pts)
    if n <= 2:
        return pts
    tol2 = tol * tol
    keep = bytearray(n)
    keep[0] = keep[n - 1] = 1
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        best, bi = tol2, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if den == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / den
                if t < 0:
                    t = 0.0
                elif t > 1:
                    t = 1.0
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best:
                best, bi = d, i
        if bi >= 0:
            keep[bi] = 1
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for i, p in enumerate(pts) if keep[i]]


def simplify_ring(ring, tol):
    """DP on a closed ring: split at the point farthest from ring[0]."""
    n = len(ring)
    if n <= 4:
        return ring
    x0, y0 = ring[0]
    far = max(range(n), key=lambda i: (ring[i][0] - x0) ** 2 + (ring[i][1] - y0) ** 2)
    a = simplify(ring[: far + 1], tol)
    b = simplify(ring[far:] + [ring[0]], tol)
    return a[:-1] + b[:-1]


# ---------------------------------------------------------------- encoding


def delta_encode(qpts):
    out = [qpts[0][0], qpts[0][1]]
    px, py = qpts[0]
    for x, y in qpts[1:]:
        out.append(x - px)
        out.append(y - py)
        px, py = x, y
    return out


def delta_decode(arr):
    pts = []
    x = y = 0
    for i in range(0, len(arr), 2):
        if i == 0:
            x, y = arr[0], arr[1]
        else:
            x += arr[i]
            y += arr[i + 1]
        pts.append((x, y))
    return pts


# ---------------------------------------------------------------- merging lines


def merge_chains(chains):
    """Join polylines (lists of keyed points) that share end points.

    `chains` is a list of lists of (key, point) where key identifies a node.
    Only joins at nodes where exactly two chain ends meet, so junctions stay
    junctions. Returns lists of points.
    """
    from collections import defaultdict

    ends = defaultdict(list)
    chains = [list(c) for c in chains if len(c) >= 2]
    alive = [True] * len(chains)
    for i, c in enumerate(chains):
        ends[c[0][0]].append(i)
        ends[c[-1][0]].append(i)

    def detach(i):
        c = chains[i]
        ends[c[0][0]].remove(i)
        ends[c[-1][0]].remove(i)

    for i in range(len(chains)):
        if not alive[i]:
            continue
        changed = True
        while changed:
            changed = False
            c = chains[i]
            if c[0][0] == c[-1][0]:
                break
            for at_end in (True, False):
                key = c[-1][0] if at_end else c[0][0]
                cands = [j for j in ends[key] if j != i and alive[j]]
                if len(ends[key]) != 2 or len(cands) != 1:
                    continue
                j = cands[0]
                o = chains[j]
                detach(i)
                detach(j)
                alive[j] = False
                if at_end:
                    if o[0][0] != key:
                        o = o[::-1]
                    c = c + o[1:]
                else:
                    if o[-1][0] != key:
                        o = o[::-1]
                    c = o[:-1] + c
                chains[i] = c
                ends[c[0][0]].append(i)
                ends[c[-1][0]].append(i)
                changed = True
                break
    return [[p for _, p in c] for i, c in enumerate(chains) if alive[i]]


# ---------------------------------------------------------------- coastline -> sea polygon


def sea_rings(chains, rect, log=print):
    """Build sea rings from coastline chains (land LEFT, water RIGHT).

    `chains`: coastline polylines in metres, already merged end to end, in the
    original OSM way direction. Pieces crossing the rectangle are connected by
    walking the rectangle boundary clockwise (y up), so the water is always on
    the right. Closed rings fully inside the rectangle (islands, enclosed
    lagoons) are returned as extra rings; with an even-odd fill they become
    holes / fills correctly.
    """
    x0, y0, x1, y1 = rect
    W, H = x1 - x0, y1 - y0
    L = 2 * (W + H)
    eps = 1e-6 * max(W, H)

    def inside(p):
        return x0 <= p[0] <= x1 and y0 <= p[1] <= y1

    def perim(p):
        x, y = p
        # clockwise from the NW corner: north edge east, east edge south, south edge west, west edge north
        d = [abs(y - y1), abs(x - x1), abs(y - y0), abs(x - x0)]
        k = d.index(min(d))
        if d[k] > 1e-3 * max(W, H):
            return None
        if k == 0:
            return x - x0
        if k == 1:
            return W + (y1 - y)
        if k == 2:
            return W + H + (x1 - x)
        return 2 * W + H + (y - y0)

    corners = [(0.0, (x0, y1)), (W, (x1, y1)), (W + H, (x1, y0)), (2 * W + H, (x0, y0))]

    closed_rings = []
    pieces = []
    for c in chains:
        closed = math.hypot(c[0][0] - c[-1][0], c[0][1] - c[-1][1]) < eps
        if closed:
            if all(inside(p) for p in c):
                closed_rings.append(c[:-1])
                continue
            # rotate so the chain starts outside, so no piece wraps around the start
            k = next(i for i, p in enumerate(c) if not inside(p))
            c = c[k:-1] + c[: k + 1]
        for piece in clip_polyline(c, rect):
            ta, tb = perim(piece[0]), perim(piece[-1])
            if ta is None or tb is None:
                log(f"  coastline: piece of {len(piece)} points has an end inside the view (broken coastline?), skipped")
                continue
            pieces.append({"pts": piece, "tin": ta, "tout": tb, "used": False})

    rings = []
    for start in pieces:
        if start["used"]:
            continue
        ring = []
        cur = start
        guard = 0
        while True:
            cur["used"] = True
            ring.extend(cur["pts"])
            t = cur["tout"]
            # next entry clockwise from t
            best = None
            bestd = None
            for p in pieces:
                if p["used"] and p is not start:
                    continue
                d = (p["tin"] - t) % L
                if bestd is None or d < bestd:
                    best, bestd = p, d
            # add rectangle corners passed on the way from t to best.tin
            for ct, cp in sorted(corners, key=lambda c: (c[0] - t) % L):
                if 0 < (ct - t) % L < bestd:
                    ring.append(cp)
            if best is start:
                break
            cur = best
            guard += 1
            if guard > 100000:
                raise RuntimeError("coastline walk did not terminate")
        rings.append(ring)

    if not pieces:
        # no crossing: whole view is either land with lakes/islands or open sea
        islands = [r for r in closed_rings if ring_area(r) > 0]
        if islands:
            rings.append([(x0, y1), (x1, y1), (x1, y0), (x0, y0)])
    return rings + closed_rings
