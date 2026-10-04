#!/usr/bin/env python3
"""Quality checks for prepared Atlas view files.

Run standalone on already-written files:
    .venv/bin/python tools/data/check.py all
    .venv/bin/python tools/data/check.py seattle-metro

prepare.py also calls check_view() after writing each view, with the full
list of polygon names seen during processing.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(1, os.path.dirname(HERE))  # geom, elevation, debug_render

from geom import delta_decode  # noqa: E402
from views import LINE_CLASSES, POLYGON_CLASSES, VIEWS  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT = os.path.join(ROOT, "public", "data")


def check_view(vid, doc, manifest, log=print, names=None):
    v = VIEWS[vid]
    fails = []

    def need(cond, msg):
        if not cond:
            fails.append(f"{vid}: {msg}")

    # ---- contract shape
    need(list(doc) == ["version", "id", "bounds", "quant", "lines", "polygons", "elevation", "label"],
         f"top-level keys {list(doc)}")
    need(doc["version"] == 2 and doc["id"] == vid and doc["bounds"] == v["bounds"] and doc["quant"] == 65535,
         "version/id/bounds/quant")
    need(sorted(doc["lines"]) == sorted(LINE_CLASSES), f"line classes {sorted(doc['lines'])}")
    need(sorted(doc["polygons"]) == sorted(POLYGON_CLASSES), f"polygon classes {sorted(doc['polygons'])}")
    q = doc["quant"]
    long_lines = 0
    for cls, lines in doc["lines"].items():
        for arr in lines:
            if len(arr) < 4 or len(arr) % 2 or any(not isinstance(x, int) for x in arr):
                fails.append(f"{vid}: bad line in {cls}")
                break
            pts = delta_decode(arr)
            if any(not (0 <= x <= q and 0 <= y <= q) for x, y in pts):
                fails.append(f"{vid}: line outside quant range in {cls}")
                break
            # a single segment longer than 25% of the view would be a stray line
            for i in range(len(pts) - 1):
                dx = pts[i + 1][0] - pts[i][0]
                dy = pts[i + 1][1] - pts[i][1]
                if dx * dx + dy * dy > (0.25 * q) ** 2:
                    long_lines += 1
                    break
    if long_lines:
        log(f"[{vid}] note: {long_lines} lines have a segment longer than 25% of the view (check debug preview)")
    for cls, polys in doc["polygons"].items():
        for poly in polys:
            if not poly or any(len(r) < 6 or len(r) % 2 for r in poly):
                fails.append(f"{vid}: bad polygon in {cls}")
                break
            if any(not (0 <= x <= q and 0 <= y <= q) for r in poly for x, y in delta_decode(r)):
                fails.append(f"{vid}: polygon outside quant range in {cls}")
                break
    e = doc["elevation"]
    need(len(e["values"]) == e["columns"] * e["rows"], "elevation size")
    need(e["min"] == min(e["values"]) and e["max"] == max(e["values"]), "elevation min/max")
    lo, hi = v["expectElevation"]
    need(lo <= e["min"] and e["max"] <= hi, f"elevation {e['min']}..{e['max']} outside expected {lo}..{hi}")
    if "expectMaxAtLeast" in v:
        need(e["max"] >= v["expectMaxAtLeast"], f"elevation max {e['max']} below {v['expectMaxAtLeast']}")
    lab = doc["label"]
    need(all(lab.get(k) for k in ("name", "region", "regionCode", "source")), f"label {lab}")

    # ---- expected features
    if names is None:
        names = {cls: [p["name"] for p in manifest["largestPolygons"].get(cls, []) if p["name"]]
                 for cls in ("water", "glacier")}
    for want in v.get("expectWater", []):
        need(want in names.get("water", []), f"expected water polygon '{want}' not found")
    for want in v.get("expectGlacier", []):
        need(want in names.get("glacier", []), f"expected glacier '{want}' not found")
    if "glacier" in v["polygonClasses"]:
        need(len(doc["polygons"]["glacier"]) > 0, "no glacier polygons")

    budget = 3_000_000
    gz = manifest["output"]["gzipBytes"]
    if v["scale"] == "metro":
        need(gz <= budget, f"gzip size {gz} over budget {budget}")
    log(f"[{vid}] checks: {'OK' if not fails else str(len(fails)) + ' failure(s)'}; "
        f"elevation {e['min']}..{e['max']} m; gzip {gz / 1e6:.2f} MB")
    return fails


def main(argv):
    vids = list(VIEWS) if argv in ([], ["all"]) else argv
    fails = []
    for vid in vids:
        with open(os.path.join(OUT, f"{vid}-v1.json")) as f:
            doc = json.load(f)
        with open(os.path.join(OUT, f"{vid}-v1.manifest.json")) as f:
            manifest = json.load(f)
        fails += check_view(vid, doc, manifest)
    for f in fails:
        print("FAIL", f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
