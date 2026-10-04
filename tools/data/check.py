#!/usr/bin/env python3
"""Checks for prepared Atlas view files (generic; driven by views/catalog.json).

    .venv/bin/python tools/data/check.py all
    .venv/bin/python tools/data/check.py pittsburgh-metro

prepare.py runs check_view() before writing each piece and refuses to write a failing one.
"""

import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import catalog  # noqa: E402
from catalog import LINE_CLASSES, POLYGON_CLASSES  # noqa: E402
from geom import delta_decode  # noqa: E402

OUT = os.path.join(catalog.ROOT, "public", "data")
MAX_GZIP_BYTES = 3_000_000


def check_view(piece, doc, log=print):
    pid = piece["id"]
    fails = []

    def need(cond, msg):
        if not cond:
            fails.append(f"{pid}: {msg}")

    need(list(doc) == ["version", "id", "bounds", "quant", "lines", "polygons", "elevation", "label"],
         f"top-level keys {list(doc)}")
    need(doc["version"] == 2 and doc["id"] == pid and doc["bounds"] == piece["bounds"] and doc["quant"] == 65535,
         "version/id/bounds/quant")
    need(sorted(doc["lines"]) == sorted(LINE_CLASSES), "line classes")
    need(set(doc["polygons"]) in (set(POLYGON_CLASSES), set(POLYGON_CLASSES) - {"wetland"}), "polygon classes")  # wetland added later
    q = doc["quant"]
    for cls, lines in doc["lines"].items():
        for arr in lines:
            if len(arr) < 4 or len(arr) % 2:
                fails.append(f"{pid}: bad line in {cls}")
                break
            if any(not (0 <= x <= q and 0 <= y <= q) for x, y in delta_decode(arr)):
                fails.append(f"{pid}: line outside quant range in {cls}")
                break
    for cls, polys in doc["polygons"].items():
        for poly in polys:
            if not poly or any(len(r) < 6 or len(r) % 2 for r in poly):
                fails.append(f"{pid}: bad polygon in {cls}")
                break
    e = doc["elevation"]
    need(len(e["values"]) == e["columns"] * e["rows"], "elevation size")
    need(e["min"] == min(e["values"]) and e["max"] == max(e["values"]), "elevation min/max")
    need(0 <= e["min"] < e["max"] <= 8900, f"elevation range {e['min']}..{e['max']}")
    if piece["style"] == "urban-relief" and piece["category"] == "cities":
        roads = sum(len(doc["lines"][c]) for c in catalog.ALL_ROAD_CLASSES)
        need(roads > 200, f"only {roads} road lines")
        minor = len(doc["lines"]["residential"])
        need(minor > 50 or catalog.PARAMS["dropResidentialAtKm"] is not None, f"only {minor} residential lines (zoom too low?)")
        if not doc["polygons"]["water"]:
            log(f"[{pid}] note: no water polygons")
    elif piece["style"] == "water-shapes":
        need(len(doc["polygons"]["water"]) > 0, "no water polygons")
    elif piece["style"] != "urban-relief":
        need(e["max"] - e["min"] >= (300 if piece["category"] == "terrain" else 60), f"relief only {e['max'] - e['min']} m")
        peak = piece.get("peak")
        if peak and abs(e["max"] - peak["elevationM"]) > 400:
            log(f"[{pid}] note: grid max {e['max']} m vs {peak['name']} {peak['elevationM']} m (framing or source)")
    size = len(gzip.compress(json.dumps(doc, separators=(",", ":")).encode(), 6))
    need(size <= MAX_GZIP_BYTES, f"gzip size {size / 1e6:.2f} MB > 3 MB")
    return fails


def main(argv):
    pieces = catalog.load()
    ids = list(pieces) if argv == ["all"] else argv
    fails = []
    for pid in ids:
        path = os.path.join(OUT, f"{pid}-v1.json")
        if not os.path.exists(path):
            print(f"{pid}: missing")
            continue
        with open(path) as f:
            fails += check_view(pieces[pid], json.load(f))
    print("\n".join(fails) if fails else f"{len(ids)} checked, all passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
