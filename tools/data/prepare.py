#!/usr/bin/env python3
"""Atlas data pipeline: views/catalog.json -> public/data/<id>-v1.json (format v2).

Usage:
    .venv/bin/python tools/data/prepare.py all
    .venv/bin/python tools/data/prepare.py pittsburgh-metro everest-ridgelines
Options:
    --force         rebuild outputs that already exist (default: skip them)
    --no-debug      skip the Pillow debug preview (data/raw/debug/<id>.png)
    --refresh-osm   re-pin the latest Protomaps daily build (new tile cache)

Per piece: 16:10 bounds from center + widthKm -> Protomaps planet PMTiles over HTTP range
requests (tiles cached in data/raw/protomaps/) -> classes, clip, merge, simplify, quantize ->
Terrarium elevation grid (cached in data/raw/terrarium/) -> view JSON + manifest -> checks.
A failing piece is reported and the run continues. See docs/DATA_PIPELINE.md.
"""

import datetime as dt
import gzip
import hashlib
import json
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import catalog  # noqa: E402
import elevation as elev  # noqa: E402
import geom  # noqa: E402
import protomaps  # noqa: E402
from catalog import LINE_CLASSES, PARAMS, POLYGON_CLASSES  # noqa: E402

ROOT = catalog.ROOT
RAW = os.path.join(ROOT, "data", "raw")
TILES = os.path.join(RAW, "terrarium")
PMTILES = os.path.join(RAW, "protomaps")
OUT = os.path.join(ROOT, "public", "data")

T0 = time.time()


def log(msg):
    print(f"[{time.time() - T0:7.1f}s] {msg}", flush=True)


def outputs(pid):
    return os.path.join(OUT, f"{pid}-v1.json"), os.path.join(OUT, f"{pid}-v1.manifest.json")


def process(piece, archive):
    pid = piece["id"]
    bounds = piece["bounds"]
    pl = catalog.plan(piece)
    proj = geom.Projector(bounds, PARAMS["quant"])
    px_m = proj.width_m / PARAMS["referenceOutputWidthPx"]
    log(f"[{pid}] {proj.width_m / 1000:.1f} x {proj.height_m / 1000:.1f} km, 1 px @3840 = {px_m:.1f} m")

    line_classes = pl["roadClasses"] + pl["lineClasses"]
    lines_m, polys_m, vstats = protomaps.extract(archive, bounds, proj, pl["vectorZoom"], line_classes,
                                                 pl["polygonClasses"], PARAMS, log=log)
    out_lines, counts, points = {}, {}, 0
    for cls in LINE_CLASSES:
        enc = []
        for line in lines_m.get(cls, []):
            q = proj.quantize(line)
            if len(q) >= 2:
                enc.append(geom.delta_encode(q))
                points += len(q)
        out_lines[cls] = enc
        counts[cls] = len(enc)
    out_polys, largest = {}, {}
    for cls in POLYGON_CLASSES:
        enc = []
        for rings, area in polys_m.get(cls, []):
            prings = []
            for r in rings:
                q = proj.quantize(r)
                if len(q) > 1 and q[0] == q[-1]:
                    q = q[:-1]
                if len(q) >= 3:
                    prings.append(geom.delta_encode(q))
                    points += len(q)
            if prings:
                enc.append(prings)
        out_polys[cls] = enc
        counts[cls] = len(enc)
        if cls in ("water", "glacier"):
            largest[cls] = [round(a / 1e6, 3) for _, a in polys_m.get(cls, [])[:5]]

    ev = pl["elevation"]
    grid, rows, emeta = elev.elevation_grid(bounds, ev["columns"], ev["zoom"], TILES, proj.kx / proj.ky,
                                            log=lambda m: log(f"[{pid}] {m}"))
    grid, pits = elev.fill_pits(grid)
    emeta["pitsFilled"] = pits
    emeta["pitThresholdM"] = elev.PIT_M
    if pits:
        log(f"[{pid}] elevation: filled {pits} pit cells (> {elev.PIT_M:.0f} m below the 5 x 5 median)")
    raw_min, raw_max = float(grid.min()), float(grid.max())
    clamp = PARAMS["elevationClampBelowM"]
    values = [int(round(max(clamp, x))) for x in grid.ravel().tolist()]
    elevation = {"columns": ev["columns"], "rows": rows, "min": min(values), "max": max(values), "values": values}
    emeta.update({"columns": ev["columns"], "rows": rows, "rawMin": round(raw_min, 1), "rawMax": round(raw_max, 1),
                  "cellM": [round(proj.width_m / ev["columns"], 1), round(proj.height_m / rows, 1)]})

    label = make_label(piece)
    doc = {"version": 2, "id": pid, "bounds": bounds, "quant": PARAMS["quant"], "lines": out_lines,
           "polygons": out_polys, "elevation": elevation, "label": label}
    log(f"[{pid}] " + ", ".join(f"{k} {v}" for k, v in counts.items() if v) +
        f"; elevation {elevation['min']}..{elevation['max']} m")
    return doc, {"plan": pl, "counts": counts, "points": points, "vector": vstats, "elevation": emeta,
                 "largest": largest, "px_m": px_m, "proj": proj}


def make_label(piece):
    """Label block text: English name, native name in its own script (and BCP-47 tag), region, summit."""
    label = {"name": piece["title"], "nativeName": piece.get("nativeName", piece["title"]), "region": piece["region"],
             "regionCode": catalog.region_code(piece["region"]), "source": "views/catalog.json"}
    if piece.get("nativeLang"):
        label["nativeLang"] = piece["nativeLang"]
    if piece.get("peak"):
        label["summit"] = {"name": piece["peak"]["name"], "elevationM": piece["peak"]["elevationM"]}
    return label


def refresh_existing(piece):
    """For an existing output: rewrite the label if the catalog changed it. False if the bounds changed (rebuild)."""
    data_path, manifest_path = outputs(piece["id"])
    with open(data_path, encoding="utf-8") as f:
        doc = json.load(f)
    if doc["bounds"] != piece["bounds"]:
        return False
    label = make_label(piece)
    if doc["label"] != label:
        doc["label"] = label
        with open(data_path, "wb") as f:
            f.write(json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
        manifest["label"] = label
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)
            f.write("\n")
        log(f"[{piece['id']}] label updated")
    return True


def write(piece, doc, meta, archive):
    pid = piece["id"]
    data = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    gz = gzip.compress(data, compresslevel=9, mtime=0)
    os.makedirs(OUT, exist_ok=True)
    data_path, manifest_path = outputs(pid)
    today = dt.date.today().isoformat()
    pl, proj = meta["plan"], meta["proj"]
    manifest = {
        "id": pid,
        "formatVersion": 2,
        "bounds": doc["bounds"],
        "boundsNote": (f"{piece['widthKm']} x {piece['widthKm'] * 10 / 16:g} km (16:10) centred on lon {piece['center'][0]}, "
                       f"lat {piece['center'][1]} in the local equirectangular approximation (sphere R = 6371008.8 m)"),
        "projection": "WGS84 lon/lat, quantized linearly; render with x scaled by cos(centre latitude)",
        "accessDate": today,
        "output": {"file": os.path.basename(data_path), "bytes": len(data), "gzipBytes": len(gz),
                   "sha256": hashlib.sha256(data).hexdigest()},
        "sources": [
            {
                "name": "Protomaps basemap, daily planet build (OpenStreetMap data)",
                "url": archive.url,
                "build": archive.key,
                "basemapVersion": archive.version,
                "license": "Open Data Commons Open Database License (ODbL) 1.0",
                "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
                "copyrightUrl": "https://www.openstreetmap.org/copyright",
                "attribution": "© OpenStreetMap contributors; basemap tiles by Protomaps (https://protomaps.com)",
                "accessDate": today,
                "vectorZoom": pl["vectorZoom"],
                "tiles": meta["vector"]["tiles"],
                "use": "Roads, rail, waterways, water incl. ocean, parks, woods, glaciers",
            },
            {
                "name": "AWS Terrain Tiles (Tilezen Joerd), Terrarium PNG",
                "url": elev.TILE_URL,
                "license": "Mixed open sources (USGS 3DEP, SRTM, GMTED2010 public domain; ETOPO1 NOAA; EU-DEM Copernicus; others)",
                "licenseUrl": "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
                "attribution": catalog.elevation_credit(piece["region"]),
                "attributionFull": catalog.JOERD_REQUIRED,
                "attributionNote": ("Required attribution list from the Joerd attribution document. The short credit "
                                    "names the sources that cover this view; sea-floor values (ETOPO1) are clamped to 0 m."),
                "accessDate": today,
                "use": "Elevation grid",
            },
        ],
        "processing": {
            "category": piece["category"],
            "style": piece["style"],
            "roadClasses": pl["roadClasses"],
            "lineClasses": pl["lineClasses"],
            "polygonClasses": pl["polygonClasses"],
            "classMapping": "tools/data/protomaps_classes.json",
            "quant": PARAMS["quant"],
            "referenceOutputWidthPx": PARAMS["referenceOutputWidthPx"],
            "lineSimplifyToleranceM": PARAMS["lineToleranceM"],
            "polygonSimplifyToleranceM": PARAMS["polygonToleranceM"],
            "minLineLengthPx": PARAMS["minLineLengthPx"],
            "minPolygonAreaPx2": PARAMS["minPolygonAreaPx2"],
            "maxProtectedAreaFraction": PARAMS["maxProtectedAreaFraction"],
            "elevationClampBelowM": PARAMS["elevationClampBelowM"],
            "derived": {"widthM": round(proj.width_m), "heightM": round(proj.height_m), "pxM": round(meta["px_m"], 2)},
            "elevation": meta["elevation"],
            "dropped": meta["vector"]["dropped"],
        },
        "featureCounts": meta["counts"],
        "pointCount": meta["points"],
        "largestPolygonsKm2": meta["largest"],
        "label": doc["label"],
        "limitations": [
            "OSM data is a snapshot of the Protomaps build named above.",
            "Geometry comes from zoom-level vector tiles, merged across tiles and simplified for about 3840 px across the view; not for navigation or analysis.",
            "Tunnels and bridges are not distinguished; footways, paths, and tracks are not included.",
            "Elevation is bilinearly resampled from Web Mercator tiles to a coarse lon/lat grid; values below 0 m are clamped to 0 m.",
        ],
        "requiredAttribution": catalog.required_attribution(piece["region"]),
    }
    with open(data_path, "wb") as f:
        f.write(data)
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")
    log(f"[{pid}] wrote {os.path.basename(data_path)}: {len(data) / 1e6:.2f} MB raw, {len(gz) / 1e6:.2f} MB gzip")
    return manifest


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    flags = {a for a in argv if a.startswith("--")}
    if not args:
        print(__doc__)
        return 2
    pieces = catalog.load()
    ids = list(pieces) if args == ["all"] else args
    unknown = [i for i in ids if i not in pieces]
    if unknown:
        print(f"unknown piece(s) {', '.join(unknown)}; known: {', '.join(pieces)}")
        return 2

    import check  # noqa: E402
    import debug_render  # noqa: E402

    archive = protomaps.Archive(PMTILES, refresh="--refresh-osm" in flags, log=log)
    done, skipped, failed = [], [], []
    for pid in ids:
        piece = pieces[pid]
        if "--force" not in flags and all(os.path.exists(p) for p in outputs(pid)) and refresh_existing(piece):
            skipped.append(pid)
            continue
        t = time.time()
        try:
            doc, meta = process(piece, archive)
            problems = check.check_view(piece, doc, log)
            if problems:
                raise RuntimeError("; ".join(problems))
            write(piece, doc, meta, archive)
            if "--no-debug" not in flags:
                debug_render.render(doc, os.path.join(RAW, "debug", f"{pid}.png"))
            done.append((pid, time.time() - t))
        except Exception as e:  # keep going; report at the end
            traceback.print_exc()
            failed.append((pid, str(e)[:300]))
            log(f"[{pid}] FAILED: {e}")
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)) if os.path.isdir(OUT) else 0
    log(f"prepared {len(done)}, skipped {len(skipped)} (exist; --force to rebuild), failed {len(failed)}; "
        f"public/data total {total / 1e6:.1f} MB")
    for pid, secs in done:
        log(f"  ok   {pid} ({secs:.0f} s)")
    for pid, err in failed:
        log(f"  FAIL {pid}: {err}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
