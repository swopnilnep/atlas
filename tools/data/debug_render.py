#!/usr/bin/env python3
"""Quick DEBUG preview of a prepared view (not the production renderer).

    .venv/bin/python tools/data/debug_render.py all
writes data/raw/debug/<view>.png about 1600 px wide: grayscale hillshade,
water blue, parks green, woods dark green, glaciers pale cyan, roads black by
class width, rail grey, waterways blue. Polygons use an even-odd fill.
"""

import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from geom import delta_decode  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

POLY_STYLE = [("wood", (95, 140, 90)), ("park", (120, 190, 110)), ("glacier", (215, 240, 250)), ("water", (40, 90, 210))]
LINE_STYLE = [
    ("stream", (40, 90, 210), 1), ("canal", (40, 90, 210), 2), ("river", (40, 90, 210), 3),
    ("service", (60, 60, 60), 1), ("residential", (20, 20, 20), 1), ("tertiary", (0, 0, 0), 2),
    ("rail", (120, 60, 60), 2), ("secondary", (0, 0, 0), 2), ("primary", (0, 0, 0), 3),
    ("trunk", (0, 0, 0), 3), ("motorway", (0, 0, 0), 4),
]


def hillshade(z, cell_x, cell_y, az=315.0, alt=45.0):
    """Lambert shade; az clockwise from north, light from the north-west by default."""
    gy, gx = np.gradient(z, cell_y, cell_x)  # row index grows SOUTH
    dzde, dzdn = gx, -gy
    norm = np.sqrt(dzde**2 + dzdn**2 + 1)
    a, h = math.radians(az), math.radians(alt)
    lx, ly, lz = math.sin(a) * math.cos(h), math.cos(a) * math.cos(h), math.sin(h)
    hs = (-dzde * lx - dzdn * ly + lz) / norm
    return np.clip(hs, 0, 1)


def render(doc, path, width=1600):
    w, s, e, n = doc["bounds"]
    latc = math.radians((s + n) / 2)
    height = round(width * (n - s) / ((e - w) * math.cos(latc)))
    q = doc["quant"]
    sx = (width - 1) / q
    sy = (height - 1) / q

    def to_px(arr):
        return [(x * sx, (q - y) * sy) for x, y in delta_decode(arr)]  # y grows north -> flip

    ev = doc["elevation"]
    z = np.array(ev["values"], dtype=float).reshape(ev["rows"], ev["columns"])
    width_m = (e - w) * 111195 * math.cos(latc)
    height_m = (n - s) * 111195
    hs = hillshade(z, width_m / ev["columns"], height_m / ev["rows"])
    span = max(1.0, ev["max"] - ev["min"])
    tone = 0.55 * hs + 0.45 * (z - ev["min"]) / span
    base = Image.fromarray((tone * 255).astype(np.uint8), "L").resize((width, height), Image.BILINEAR)
    img = Image.merge("RGB", (base, base, base))
    img = Image.blend(img, Image.new("RGB", img.size, (255, 255, 255)), 0.35)

    for cls, color in POLY_STYLE:
        mask = Image.new("1", (width, height), 0)
        md = ImageDraw.Draw(mask)
        for poly in doc["polygons"][cls]:
            rings = [to_px(r) for r in poly]
            if len(rings) == 1:
                md.polygon(rings[0], fill=1)
                continue
            pm = Image.new("1", (width, height), 0)
            for r in rings:
                rm = Image.new("1", (width, height), 0)
                ImageDraw.Draw(rm).polygon(r, fill=1)
                pm = ImageChops.logical_xor(pm, rm)
            mask = ImageChops.logical_or(mask, pm)
            md = ImageDraw.Draw(mask)
        img.paste(Image.new("RGB", img.size, color), (0, 0), mask)

    d = ImageDraw.Draw(img)
    for cls, color, lw in LINE_STYLE:
        for arr in doc["lines"][cls]:
            d.line(to_px(arr), fill=color, width=lw)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    return path


def main(argv):
    from views import VIEWS

    vids = list(VIEWS) if argv in ([], ["all"]) else argv
    for vid in vids:
        with open(os.path.join(ROOT, "public", "data", f"{vid}-v1.json")) as f:
            doc = json.load(f)
        print(render(doc, os.path.join(ROOT, "data", "raw", "debug", f"{vid}.png")))


if __name__ == "__main__":
    main(sys.argv[1:])
