#!/usr/bin/env python3
"""LEGACY Atlas data pipeline (Geofabrik US state extracts). Superseded by tools/data/prepare.py
(Protomaps + catalog). Kept so the three original views can be rebuilt from Geofabrik for comparison;
it writes to the same public/data/ files.

Usage:
    .venv/bin/python tools/data/prepare.py austin-metro
    .venv/bin/python tools/data/prepare.py seattle-metro mount-rainier-summit
    .venv/bin/python tools/data/prepare.py all
Options:
    --no-debug      skip the Pillow debug preview
    --re-extract    rebuild the per-view OSM extract even if cached

Steps per view: download state extract (cached) -> per-view OSM extract
(cached) -> assemble areas, clip, simplify, quantize -> elevation grid from
Terrain Tiles (cached) -> view JSON + manifest -> checks -> debug PNG.
See docs/DATA_PIPELINE.md.
"""

import datetime as dt
import gzip
import hashlib
import json
import math
import os
import sys
import time
import urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(1, os.path.dirname(HERE))  # geom, elevation, debug_render

import osmium  # noqa: E402

import elevation as elev  # noqa: E402
import geom  # noqa: E402
from views import GEOFABRIK, LINE_CLASSES, PARAMS, POLYGON_CLASSES, VIEWS  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RAW = os.path.join(ROOT, "data", "raw")
EXTRACTS = os.path.join(RAW, "extract")
TILES = os.path.join(RAW, "terrarium")
OUT = os.path.join(ROOT, "public", "data")
USER_AGENT = "Atlas data preparation (https://atlas.swopnil.com; local one-off build)"

T0 = time.time()


def log(msg):
    print(f"[{time.time() - T0:7.1f}s] {msg}", flush=True)


# ---------------------------------------------------------------- tag rules

ROAD_MAP = {
    "motorway": "motorway", "motorway_link": "motorway",
    "trunk": "trunk", "trunk_link": "trunk",
    "primary": "primary", "primary_link": "primary",
    "secondary": "secondary", "secondary_link": "secondary",
    "tertiary": "tertiary", "tertiary_link": "tertiary",
    "residential": "residential", "unclassified": "residential", "living_street": "residential",
    "service": "service",
}
RAIL_VALUES = {"rail", "light_rail"}
WATERWAY_LINES = {"river": "river", "stream": "stream", "canal": "canal"}


def line_class(tags):
    hw = tags.get("highway")
    if hw in ROAD_MAP and tags.get("area") != "yes":
        return ROAD_MAP[hw]
    rw = tags.get("railway")
    if rw in RAIL_VALUES and "service" not in tags:
        return "rail"
    ww = tags.get("waterway")
    if ww in WATERWAY_LINES and tags.get("tunnel") != "culvert":
        return WATERWAY_LINES[ww]
    return None


def polygon_class(tags):
    nat = tags.get("natural")
    if nat == "glacier":
        return "glacier"
    if nat in ("water", "bay") or "water" in tags or tags.get("landuse") == "reservoir" or tags.get("waterway") == "riverbank":
        return "water"
    if tags.get("leisure") in ("park", "nature_reserve", "garden") or tags.get("landuse") == "recreation_ground":
        return "park"
    if tags.get("boundary") in ("national_park", "protected_area"):
        return "park"
    if nat == "wood" or tags.get("landuse") == "forest":
        return "wood"
    return None


def is_big_protected(tags):
    return tags.get("boundary") in ("national_park", "protected_area") or tags.get("leisure") == "nature_reserve"


def is_state_boundary(tags):
    return (tags.get("boundary") == "administrative" and tags.get("admin_level") == "4"
            and str(tags.get("ISO3166-2", "")).startswith("US-"))


def way_of_interest(tags):
    return line_class(tags) is not None or polygon_class(tags) is not None or tags.get("natural") == "coastline"


# ---------------------------------------------------------------- downloads


def download(url, path):
    if os.path.exists(path):
        log(f"cached {os.path.relpath(path, ROOT)} ({os.path.getsize(path) / 1e6:.0f} MB)")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    log(f"downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    tmp = path + ".part"
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, path)
    log(f"downloaded {os.path.getsize(path) / 1e6:.0f} MB")


def state_file(state):
    return os.path.join(RAW, f"{state}-latest.osm.pbf")


def pbf_header(path):
    r = osmium.io.Reader(path, osmium.osm.NODE)
    h = r.header()
    info = {
        "replicationTimestamp": h.get("osmosis_replication_timestamp") or h.get("timestamp") or None,
        "replicationUrl": h.get("osmosis_replication_base_url") or None,
    }
    r.close()
    return info


# ---------------------------------------------------------------- extract


def build_extracts(state, view_ids):
    """One pass over the state file builds a small reference-complete extract
    for every requested view of that state."""
    src = state_file(state)
    targets = {}
    for vid in view_ids:
        b = VIEWS[vid]["bounds"]
        buf = PARAMS["extractBufferDeg"]
        targets[vid] = {
            "box": (b[0] - buf, b[1] - buf, b[2] + buf, b[3] + buf),
            "coarse": (b[0] - 0.3, b[1] - 0.3, b[2] + 0.3, b[3] + 0.3),
            "tracker": osmium.IdTracker(),
            "path": os.path.join(EXTRACTS, f"{vid}.osm.pbf"),
            "ways": 0,
            "rels": 0,
        }
    os.makedirs(EXTRACTS, exist_ok=True)

    log(f"[{state}] pass 1/4: candidate relations")
    rel_members = defaultdict(list)  # way id -> relation ids
    rel_tags = {}
    for r in osmium.FileProcessor(src, osmium.osm.RELATION).with_filter(osmium.filter.KeyFilter("type")):
        tags = r.tags
        if tags.get("type") not in ("multipolygon", "boundary"):
            continue
        if polygon_class(tags) is None and not is_state_boundary(tags):
            continue
        rel_tags[r.id] = is_state_boundary(tags)
        for m in r.members:
            if m.type == "w":
                rel_members[m.ref].append(r.id)
    log(f"[{state}]   {len(rel_tags)} candidate relations, {len(rel_members)} member ways")

    log(f"[{state}] pass 2/4: ways intersecting views")
    hit_rels = {vid: set() for vid in view_ids}
    for vid in view_ids:
        # state boundaries are always included (for the region code)
        hit_rels[vid].update(rid for rid, is_state in rel_tags.items() if is_state)
    n_seen = 0
    fp = osmium.FileProcessor(src, osmium.osm.NODE | osmium.osm.WAY).with_locations().with_filter(
        osmium.filter.EntityFilter(osmium.osm.WAY))
    for w in fp:
        n_seen += 1
        wid = w.id
        member_of = rel_members.get(wid)
        if member_of is None and not way_of_interest(w.tags):
            continue
        nodes = w.nodes
        nn = len(nodes)
        if nn == 0:
            continue
        try:
            lon0, lat0 = nodes[0].lon, nodes[0].lat
        except Exception:  # noqa: BLE001  invalid location
            continue
        for vid, t in targets.items():
            cx0, cy0, cx1, cy1 = t["coarse"]
            if not (cx0 <= lon0 <= cx1 and cy0 <= lat0 <= cy1) and nn < 200:
                continue
            x0, y0, x1, y1 = t["box"]
            mnx = mny = 1e9
            mxx = mxy = -1e9
            for nd in nodes:
                loc = nd.location
                if not loc.valid():
                    continue
                lo, la = loc.lon, loc.lat
                if lo < mnx:
                    mnx = lo
                if lo > mxx:
                    mxx = lo
                if la < mny:
                    mny = la
                if la > mxy:
                    mxy = la
            if mxx < x0 or mnx > x1 or mxy < y0 or mny > y1:
                continue
            t["tracker"].add_way(wid)
            t["ways"] += 1
            if member_of:
                hit_rels[vid].update(member_of)
    log(f"[{state}]   scanned {n_seen} ways")

    log(f"[{state}] pass 3/4: place and peak nodes")
    for n in osmium.FileProcessor(src, osmium.osm.NODE).with_filter(
            osmium.filter.TagFilter(("place", "city"), ("place", "town"), ("natural", "peak"))):
        for t in targets.values():
            x0, y0, x1, y1 = t["box"]
            if x0 <= n.location.lon <= x1 and y0 <= n.location.lat <= y1:
                t["tracker"].add_node(n.id)

    log(f"[{state}] pass 4/4: completing references and writing extracts")
    for vid, t in targets.items():
        for rid in hit_rels[vid]:
            t["tracker"].add_relation(rid)
        t["rels"] = len(hit_rels[vid])
        t["tracker"].complete_backward_references(src, relation_depth=1)
        tmp = t["path"] + ".part.osm.pbf"
        if os.path.exists(tmp):
            os.remove(tmp)
        with osmium.SimpleWriter(tmp) as writer:
            for obj in osmium.FileProcessor(src).with_filter(t["tracker"].id_filter()):
                writer.add(obj)
        os.replace(tmp, t["path"])
        log(f"[{state}]   {vid}: {t['ways']} ways in view, {t['rels']} relations, "
            f"{os.path.getsize(t['path']) / 1e6:.1f} MB extract")


# ---------------------------------------------------------------- per-view processing


def point_in_rings(x, y, rings):
    inside = False
    for ring in rings:
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
    return inside


def process_view(vid):
    v = VIEWS[vid]
    bounds = v["bounds"]
    P = PARAMS
    proj = geom.Projector(bounds, P["quant"])
    rect = proj.rect()
    px_m = proj.width_m / P["referenceOutputWidthPx"]
    min_len = P["minLineLengthPx"] * px_m
    min_area = P["minPolygonAreaPx2"] * px_m * px_m
    view_area = proj.width_m * proj.height_m
    road_classes = set(v["roadClasses"])
    line_classes = road_classes | set(v["lineClasses"])
    poly_classes = set(v["polygonClasses"])
    extract = os.path.join(EXTRACTS, f"{vid}.osm.pbf")
    log(f"[{vid}] {proj.width_m / 1000:.1f} x {proj.height_m / 1000:.1f} km, 1 px @3840 = {px_m:.1f} m")

    raw_lines = defaultdict(list)  # class -> list of [(node id, (x, y))]
    coast = []
    polys = defaultdict(list)  # class -> list of (polygon rings in metres, area, name, osm ref)
    places = []
    states = []
    dropped = defaultdict(int)

    fp = osmium.FileProcessor(extract).with_areas()
    for obj in fp:
        if obj.is_node():
            tags = obj.tags
            if "name" in tags:
                places.append({"id": obj.id, "tags": dict(tags), "lon": obj.location.lon, "lat": obj.location.lat})
            continue
        if obj.is_way():
            tags = obj.tags
            lc = line_class(tags)
            is_coast = tags.get("natural") == "coastline"
            if lc not in line_classes and not is_coast:
                continue
            pts = []
            for nd in obj.nodes:
                if nd.location.valid():
                    pts.append((nd.ref, proj.to_m(nd.lon, nd.lat)))
            if len(pts) < 2:
                continue
            if is_coast:
                coast.append(pts)
            if lc in line_classes:
                raw_lines[lc].append(pts)
            continue
        if obj.is_area():
            tags = obj.tags
            if is_state_boundary(tags):
                rings = []
                for outer in obj.outer_rings():
                    rings.append([(n.lon, n.lat) for n in outer])
                    for inner in obj.inner_rings(outer):
                        rings.append([(n.lon, n.lat) for n in inner])
                states.append({"name": tags.get("name"), "iso": tags.get("ISO3166-2"), "rings": rings,
                               "id": obj.orig_id()})
                continue
            pc = polygon_class(tags)
            if pc not in poly_classes:
                continue
            rings = []
            area = 0.0  # net area in m2: outer rings minus holes, after clipping
            for outer in obj.outer_rings():
                o = [proj.to_m(n.lon, n.lat) for n in outer][:-1]
                o = geom.clip_ring(o, rect)
                if len(o) < 3:
                    continue
                oa = abs(geom.ring_area(o))
                if oa < min_area:
                    dropped[f"{pc} ring (smaller than {P['minPolygonAreaPx2']} px2)"] += 1
                    continue
                rings.append(o)
                area += oa
                for inner in obj.inner_rings(outer):
                    h = [proj.to_m(n.lon, n.lat) for n in inner][:-1]
                    h = geom.clip_ring(h, rect)
                    if len(h) >= 3:
                        ha = abs(geom.ring_area(h))
                        if ha >= min_area:
                            rings.append(h)
                            area -= ha
            if not rings:
                continue
            if pc == "park" and is_big_protected(tags) and area > P["maxProtectedAreaFraction"] * view_area:
                dropped["park (protected area too large)"] += 1
                continue
            ref = ("w" if obj.from_way() else "r") + str(obj.orig_id())
            polys[pc].append((rings, area, tags.get("name"), ref))

    log(f"[{vid}] read: " + ", ".join(f"{k} {len(x)}" for k, x in raw_lines.items()) +
        f"; coastline ways {len(coast)}; " + ", ".join(f"{k} {len(x)}" for k, x in polys.items()))

    # ---- sea from coastline
    if v["coastline"] and coast:
        chains = geom.merge_chains(coast)
        rings = geom.sea_rings(chains, rect, log=lambda m: log(f"[{vid}] {m}"))
        rings = [r for r in rings if len(r) >= 3 and abs(geom.ring_area(r)) >= min_area]
        if rings:
            sea_area = sum(geom.ring_area(r) for r in rings)
            log(f"[{vid}] sea from coastline: {len(chains)} chains, {len(rings)} rings, "
                f"signed area {sea_area / 1e6:.1f} km2 ({100 * sea_area / view_area:.0f}% of view)")
            polys["water"].insert(0, (rings, abs(sea_area), "Puget Sound (coastline sea)", "coastline"))

    # ---- lines: merge, clip, simplify, quantize
    out_lines = {}
    counts = {}
    points_total = 0
    for cls in LINE_CLASSES:
        enc = []
        if cls in raw_lines:
            merged = geom.merge_chains(raw_lines[cls])
            for line in merged:
                for piece in geom.clip_polyline(line, rect):
                    if geom.line_length(piece) < min_len:
                        dropped[f"{cls} (shorter than {P['minLineLengthPx']} px)"] += 1
                        continue
                    s = geom.simplify(piece, P["lineToleranceM"])
                    q = proj.quantize(s)
                    if len(q) < 2:
                        continue
                    enc.append(geom.delta_encode(q))
                    points_total += len(q)
        out_lines[cls] = enc
        counts[cls] = len(enc)

    # ---- polygons: simplify, quantize
    out_polys = {}
    water_names = []
    for cls in POLYGON_CLASSES:
        enc = []
        for rings, area, name, ref in polys.get(cls, []):
            prings = []
            for r in rings:
                s = geom.simplify_ring(r, P["polygonToleranceM"])
                q = proj.quantize(s)
                if len(q) > 1 and q[0] == q[-1]:
                    q = q[:-1]
                if len(q) >= 3:
                    prings.append(geom.delta_encode(q))
                    points_total += len(q)
            if prings:
                enc.append(prings)
                if cls in ("water", "glacier"):
                    water_names.append((cls, area, name, ref))
        out_polys[cls] = enc
        counts[cls] = len(enc)

    largest = {}
    all_names = {}
    for cls in ("water", "glacier"):
        items = sorted([w for w in water_names if w[0] == cls], key=lambda w: -w[1])[:10]
        largest[cls] = [{"name": n, "osm": ref, "areaKm2": round(a / 1e6, 3)} for _, a, n, ref in items]
        all_names[cls] = sorted({n for c, _, n, _ in water_names if c == cls and n})
        if items:
            log(f"[{vid}] largest {cls} polygons: " + "; ".join(
                f"{n or '(unnamed)'} {a / 1e6:.2f} km2" for _, a, n, ref in items))

    # ---- elevation
    ev = v["elevation"]
    grid, rows, emeta = elev.elevation_grid(bounds, ev["columns"], ev["zoom"], TILES, proj.kx / proj.ky,
                                            log=lambda m: log(f"[{vid}] {m}"))
    raw_min, raw_max = float(grid.min()), float(grid.max())
    clamp = P["elevationClampBelowM"]
    values = [int(round(max(clamp, x))) for x in grid.ravel().tolist()]
    elevation = {"columns": ev["columns"], "rows": rows, "min": min(values), "max": max(values), "values": values}
    emeta.update({"columns": ev["columns"], "rows": rows, "rawMin": round(raw_min, 1), "rawMax": round(raw_max, 1),
                  "cellM": [round(proj.width_m / ev["columns"], 1), round(proj.height_m / rows, 1)]})
    log(f"[{vid}] elevation {ev['columns']}x{rows}: raw {raw_min:.1f}..{raw_max:.1f} m, stored {elevation['min']}..{elevation['max']} m")

    # ---- label
    label, label_meta = make_label(vid, v, places, states, bounds)
    log(f"[{vid}] label: {label}")

    doc = {
        "version": 2,
        "id": vid,
        "bounds": bounds,
        "quant": P["quant"],
        "lines": out_lines,
        "polygons": out_polys,
        "elevation": elevation,
        "label": label,
    }
    return doc, {
        "counts": counts,
        "points": points_total,
        "dropped": dict(dropped),
        "largest": largest,
        "names": all_names,
        "elevation": emeta,
        "label": label_meta,
        "projection": {"widthM": round(proj.width_m), "heightM": round(proj.height_m),
                       "pxM": round(px_m, 2), "minLineLengthM": round(min_len, 1), "minPolygonAreaM2": round(min_area)},
    }


def make_label(vid, v, places, states, bounds):
    w, s, e, n = bounds
    cx, cy = (w + e) / 2, (s + n) / 2
    lab = v["label"]
    chosen = None
    name_tag = "name"
    if lab["kind"] == "peak":
        # The summit node of Mount Rainier is named "Columbia Crest" and carries
        # massif:name=Mount Rainier, so accept either tag; prefer the highest node.
        def ele(p):
            try:
                return float(str(p["tags"].get("ele", "0")).split()[0])
            except ValueError:
                return 0.0
        peaks = [p for p in places if p["tags"].get("natural") == "peak"
                 and lab["name"] in (p["tags"].get("name"), p["tags"].get("massif:name"))]
        if peaks:
            chosen = max(peaks, key=ele)
            name_tag = "name" if chosen["tags"].get("name") == lab["name"] else "massif:name"
    else:
        inb = [p for p in places if p["tags"].get("place") in lab["place"] and w <= p["lon"] <= e and s <= p["lat"] <= n]
        if inb:
            def score(p):
                pop = 0
                try:
                    pop = int(str(p["tags"].get("population", "0")).replace(",", ""))
                except ValueError:
                    pass
                d = math.hypot((p["lon"] - cx) * math.cos(math.radians(cy)), p["lat"] - cy)
                return (d > 0.05, -pop, d)
            chosen = min(inb, key=score)
    if chosen is None:
        raise RuntimeError(f"{vid}: no label node found")
    px, py = chosen["lon"], chosen["lat"]
    region = None
    for st in states:
        if point_in_rings(px, py, st["rings"]):
            region = st
            break
    if region is None:
        raise RuntimeError(f"{vid}: label point is not inside any assembled US state boundary")
    code = region["iso"].split("-", 1)[1]
    kind = f"natural=peak, {name_tag}" if lab["kind"] == "peak" else f"place={chosen['tags'].get('place')}"
    label = {
        "name": chosen["tags"][name_tag],
        "region": region["name"],
        "regionCode": code,
        "source": f"OSM node {chosen['id']} ({kind}); region from OSM relation {region['id']} (ISO3166-2={region['iso']})",
    }
    meta = {"node": chosen["id"], "nodeName": chosen["tags"].get("name"), "lon": px, "lat": py,
            "stateRelation": region["id"], "ele": chosen["tags"].get("ele")}
    return label, meta


# ---------------------------------------------------------------- output


def write_view(vid, doc, meta, header, state_url):
    v = VIEWS[vid]
    text = json.dumps(doc, separators=(",", ":"), ensure_ascii=False)
    data = text.encode("utf-8")
    gz = gzip.compress(data, compresslevel=9, mtime=0)
    sha = hashlib.sha256(data).hexdigest()
    os.makedirs(OUT, exist_ok=True)
    out_file = f"{vid}-v1.json"
    with open(os.path.join(OUT, out_file), "wb") as f:
        f.write(data)
    today = dt.date.today().isoformat()
    P = PARAMS
    manifest = {
        "id": vid,
        "formatVersion": 2,
        "bounds": v["bounds"],
        "boundsNote": (f"{v['widthMeters'] / 1000:.0f} x {v['heightMeters'] / 1000:.0f} km rectangle centred on {v['center'][0]}, {v['center'][1]} "
                       "in the local equirectangular approximation (lon span = lat span / cos(centre lat), "
                       "sphere R = 6371008.8 m)") if "center" in v else None,
        "projection": "WGS84 lon/lat, quantized linearly; render with x scaled by cos(centre latitude)",
        "accessDate": today,
        "output": {"file": out_file, "bytes": len(data), "gzipBytes": len(gz), "sha256": sha},
        "sources": [
            {
                "name": "OpenStreetMap via Geofabrik state extract",
                "url": state_url,
                "license": "Open Data Commons Open Database License (ODbL) 1.0",
                "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
                "copyrightUrl": "https://www.openstreetmap.org/copyright",
                "attribution": "© OpenStreetMap contributors",
                "accessDate": today,
                "extractTimestamp": header.get("replicationTimestamp"),
                "use": "Roads, rail, waterways, water, parks, woods, glaciers, coastline, label names",
            },
            {
                "name": "AWS Terrain Tiles (Tilezen Joerd), Terrarium PNG",
                "url": elev.TILE_URL,
                "license": "Mixed public sources; in the United States the source is USGS 3DEP (formerly NED), public domain",
                "licenseUrl": "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
                "attribution": ("United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data "
                                "courtesy of the U.S. Geological Survey."),
                "attributionNote": ("Text from the Joerd attribution document's required-attribution list (US line). "
                                    "USGS asks for the credit '3DEP data courtesy of the U.S. Geological Survey'. "
                                    "Sea-floor values near coasts may come from ETOPO1 (NOAA); they are clamped to "
                                    "0 m in this file."),
                "accessDate": today,
                "use": "Elevation grid",
            },
        ],
        "processing": {
            "scale": v["scale"],
            "roadClasses": v["roadClasses"],
            "lineClasses": v["lineClasses"],
            "polygonClasses": v["polygonClasses"],
            "quant": P["quant"],
            "referenceOutputWidthPx": P["referenceOutputWidthPx"],
            "lineSimplifyToleranceM": P["lineToleranceM"],
            "polygonSimplifyToleranceM": P["polygonToleranceM"],
            "minLineLengthPx": P["minLineLengthPx"],
            "minPolygonAreaPx2": P["minPolygonAreaPx2"],
            "maxProtectedAreaFraction": P["maxProtectedAreaFraction"],
            "extractBufferDeg": P["extractBufferDeg"],
            "elevationClampBelowM": P["elevationClampBelowM"],
            "derived": meta["projection"],
            "elevation": meta["elevation"],
            "seaFromCoastline": v["coastline"],
            "dropped": meta["dropped"],
        },
        "featureCounts": meta["counts"],
        "pointCount": meta["points"],
        "largestPolygons": meta["largest"],
        "label": doc["label"],
        "labelSource": meta["label"],
        "limitations": [
            "OSM data is a snapshot of the extract timestamp; it changes when the script is rerun on a newer extract.",
            "Geometry is simplified for print at about 3840 px across the view; it is not suitable for navigation or analysis.",
            "Roads include tunnels and bridges without distinction; footways, paths and tracks are not included.",
            "Rail excludes service tracks (yards, sidings, spurs). Waterways in culverts are excluded.",
            "Polygons are clipped to the view with Sutherland-Hodgman; clipped edges run along the view border.",
            "Elevation is bilinearly resampled from Web Mercator tiles to a coarse lon/lat grid; values below 0 m are clamped to 0 m.",
        ] + (["Sea is built from natural=coastline ways (water on the right of way direction), closed along the view border."]
             if v["coastline"] else []),
        "requiredAttribution": "© OpenStreetMap contributors · Elevation: 3DEP data courtesy of the U.S. Geological Survey",
    }
    if manifest["boundsNote"] is None:
        del manifest["boundsNote"]
    with open(os.path.join(OUT, f"{vid}-v1.manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")
    log(f"[{vid}] wrote {out_file}: {len(data) / 1e6:.2f} MB raw, {len(gz) / 1e6:.2f} MB gzip, sha256 {sha[:12]}")
    return manifest


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    flags = {a for a in argv if a.startswith("--")}
    if not args:
        print(__doc__)
        return 2
    view_ids = list(VIEWS) if args == ["all"] else args
    for vid in view_ids:
        if vid not in VIEWS:
            print(f"unknown view {vid}; known: {', '.join(VIEWS)}")
            return 2
    by_state = defaultdict(list)
    for vid in view_ids:
        by_state[VIEWS[vid]["state"]].append(vid)

    import check  # noqa: E402
    import debug_render  # noqa: E402

    failures = []
    for state, vids in by_state.items():
        url = GEOFABRIK.format(state=state)
        download(url, state_file(state))
        header = pbf_header(state_file(state))
        need = [vid for vid in vids if "--re-extract" in flags or not os.path.exists(os.path.join(EXTRACTS, f"{vid}.osm.pbf"))]
        if need:
            build_extracts(state, need)
        else:
            log(f"[{state}] using cached extracts for {', '.join(vids)}")
        for vid in vids:
            doc, meta = process_view(vid)
            manifest = write_view(vid, doc, meta, header, url)
            failures += check.check_view(vid, doc, manifest, log, names=meta["names"])
            if "--no-debug" not in flags:
                path = debug_render.render(doc, os.path.join(RAW, "debug", f"{vid}.png"))
                log(f"[{vid}] debug preview {os.path.relpath(path, ROOT)}")
    if failures:
        log("CHECK FAILURES:\n  " + "\n  ".join(failures))
        return 1
    log("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
