"""Vector data from the Protomaps daily planet build (PMTiles over HTTP range requests).

Source: https://build.protomaps.com/<key>, key = last entry of
https://build-metadata.protomaps.dev/builds.json. Basemap schema v4 (layers roads, water,
landuse, ...). © OpenStreetMap contributors (ODbL); Protomaps basemap.

The key is pinned in data/raw/protomaps/build.json so reruns use the same build and the tile
cache (data/raw/protomaps/<key>/<z>/<x>/<y>.mvt) stays valid. `--refresh-osm` re-pins the latest.
"""

import gzip
import json
import math
import os
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import mapbox_vector_tile
import numpy as np
import requests
import shapely
from mapbox_vector_tile.Mapbox import vector_tile_pb2
from pmtiles.reader import Reader
from shapely.geometry import box as shp_box
from shapely.geometry import shape

HERE = os.path.dirname(os.path.abspath(__file__))
BUILDS_URL = "https://build-metadata.protomaps.dev/builds.json"
FILE_URL = "https://build.protomaps.com/{key}"
USER_AGENT = "Atlas data preparation (https://atlas.swopnil.com; local one-off build)"
WANT_LAYERS = {"roads", "water", "landuse"}

with open(os.path.join(HERE, "protomaps_classes.json")) as _f:
    CLASSES = json.load(_f)


# ---------------------------------------------------------------- class mapping


def classify(layer, props, geom_type):
    """Atlas class for one Protomaps feature, or None. geom_type: 'line' or 'polygon'."""
    kind = props.get("kind")
    detail = props.get("kind_detail")
    if layer == "roads" and geom_type == "line":
        r = CLASSES["roads"]
        if kind in r["kinds"]:
            return r["byKindDetail"].get(detail)
        return None
    if layer == "water":
        if geom_type == "line":
            return CLASSES["waterLines"]["byKind"].get(kind)
        w = CLASSES["waterPolygons"]
        if kind in w["excludeKinds"] or detail in w["excludeKindDetails"]:
            return None
        return w["class"]
    if layer == "landuse" and geom_type == "polygon":
        return CLASSES["landuse"]["byKind"].get(kind)
    return None


def is_protected(props):
    return props.get("kind") in CLASSES["landuse"]["protectedKinds"]


# ---------------------------------------------------------------- tiles


def tile_range(bounds, z):
    w, s, e, n = bounds
    k = 2**z

    def tx(lon):
        return int((lon + 180) / 360 * k)

    def ty(lat):
        r = math.radians(lat)
        return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * k)

    return tx(w), tx(e), ty(n), ty(s)


def tile_lon(x, z):
    return x / 2**z * 360 - 180


def tile_lat(y, z):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / 2**z))))


class Archive:
    def __init__(self, cache_root, refresh=False, log=print):
        self.log = log
        os.makedirs(cache_root, exist_ok=True)
        pin = os.path.join(cache_root, "build.json")
        meta = None
        if os.path.exists(pin) and not refresh:
            with open(pin) as f:
                meta = json.load(f)
        if meta is None:
            req = urllib.request.Request(BUILDS_URL, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as r:
                builds = json.load(r)
            meta = builds[-1]
            with open(pin, "w") as f:
                json.dump(meta, f, indent=2)
            log(f"protomaps: pinned build {meta['key']} (basemap {meta.get('version')})")
        self.key = meta["key"]
        self.version = meta.get("version")
        self.url = FILE_URL.format(key=self.key)
        self.cache = os.path.join(cache_root, self.key.replace(".pmtiles", ""))
        self._local = threading.local()
        self._memo = {}
        self._lock = threading.Lock()
        self._reader = None
        self._header = None

    def _session(self):
        s = getattr(self._local, "s", None)
        if s is None:
            s = self._local.s = requests.Session()
            s.headers["User-Agent"] = USER_AGENT
        return s

    def _fetch(self, offset, length):
        for attempt in range(4):
            try:
                r = self._session().get(self.url, headers={"Range": f"bytes={offset}-{offset + length - 1}"}, timeout=60)
                r.raise_for_status()
                if len(r.content) != length:
                    raise IOError(f"short read {len(r.content)} of {length}")
                return r.content
            except Exception:
                if attempt == 3:
                    raise
        raise RuntimeError("unreachable")

    def _get(self, offset, length):
        h = self._header
        in_tiles = h is not None and h["tile_data_offset"] <= offset < h["tile_data_offset"] + h["tile_data_length"]
        if in_tiles:
            return self._fetch(offset, length)
        key = (offset, length)
        with self._lock:
            if key in self._memo:
                return self._memo[key]
        data = self._fetch(offset, length)
        with self._lock:
            self._memo[key] = data
        return data

    def reader(self):
        if self._reader is None:
            self._reader = Reader(self._get)
            self._header = self._reader.header()
        return self._reader

    def tile(self, z, x, y):
        """Raw (uncompressed) MVT bytes for one tile; b'' for an empty tile. Cached on disk."""
        path = os.path.join(self.cache, str(z), str(x), f"{y}.mvt")
        if os.path.exists(path):
            with open(path, "rb") as f:
                return f.read()
        data = self.reader().get(z, x, y) or b""
        if data[:2] == b"\x1f\x8b":
            data = gzip.decompress(data)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        return data

    def tiles(self, z, coords, workers=16):
        self.reader()
        with ThreadPoolExecutor(workers) as ex:
            return list(ex.map(lambda c: self.tile(z, *c), coords))


def decode_tile(data):
    """Decodes only the layers we use (buildings and POIs are the bulk of a z14 tile)."""
    if not data:
        return {}
    t = vector_tile_pb2.tile()
    t.ParseFromString(data)
    for i in range(len(t.layers) - 1, -1, -1):
        if t.layers[i].name not in WANT_LAYERS:
            del t.layers[i]
    return mapbox_vector_tile.decode(t.SerializeToString(), default_options={"y_coord_down": True})


# ---------------------------------------------------------------- assembly


def extract(archive, bounds, proj, zoom, line_classes, polygon_classes, params, log=print):
    """Lines and polygons in local metres, clipped to the view, merged across tiles, simplified.

    Returns (lines: class -> [ [(x, y), ...] ], polygons: class -> [ (rings, area_m2) ], stats).
    """
    x0, x1, y0, y1 = tile_range(bounds, zoom)
    coords = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    log(f"  protomaps: z{zoom}, {len(coords)} tiles (x {x0}..{x1}, y {y0}..{y1}), build {archive.key}")
    blobs = archive.tiles(zoom, coords)
    W, H = proj.width_m, proj.height_m
    view_box = shp_box(0, 0, W, H)
    lines = {c: [] for c in line_classes}
    polys = {c: [] for c in polygon_classes}
    protected = []
    n = 2**zoom
    tile_bytes = 0
    for (tx, ty), blob in zip(coords, blobs):
        tile_bytes += len(blob)
        layers = decode_tile(blob)
        if not layers:
            continue
        lon0, lon1 = tile_lon(tx, zoom), tile_lon(tx + 1, zoom)
        lat0, lat1 = tile_lat(ty, zoom), tile_lat(ty + 1, zoom)
        bx0, by1 = proj.to_m(lon0, lat0)
        bx1, by0 = proj.to_m(lon1, lat1)
        clip = shp_box(max(0, bx0), max(0, by0), min(W, bx1), min(H, by1))
        if clip.is_empty or clip.area <= 0:
            continue

        def to_m(c, _tx=tx, _ty=ty, _ext=4096.0):
            u = (_tx + c[:, 0] / _ext) / n
            v = (_ty + c[:, 1] / _ext) / n
            lon = u * 360 - 180
            lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * v))))
            return np.column_stack(((lon - proj.w) * proj.kx, (lat - proj.s) * proj.ky))

        for lname, layer in layers.items():
            for f in layer["features"]:
                g = f["geometry"]
                gt = g["type"]
                kind = "line" if "LineString" in gt else "polygon" if "Polygon" in gt else None
                if kind is None:
                    continue
                cls = classify(lname, f["properties"], kind)
                if cls is None:
                    continue
                if kind == "line" and cls not in lines:
                    continue
                if kind == "polygon" and cls not in polys:
                    continue
                try:
                    geom = shapely.transform(shape(g), to_m)
                except Exception:
                    continue
                if kind == "polygon":
                    if not geom.is_valid:
                        geom = shapely.make_valid(geom)
                    geom = geom.intersection(clip)
                    if geom.is_empty:
                        continue
                    if cls == "park" and is_protected(f["properties"]):
                        protected.append(geom)
                    else:
                        polys[cls].append(geom)
                else:
                    geom = geom.intersection(clip)
                    if not geom.is_empty:
                        lines[cls].append(geom)

    px_m = W / params["referenceOutputWidthPx"]
    min_len = params["minLineLengthPx"] * px_m
    min_area = params["minPolygonAreaPx2"] * px_m * px_m
    stats = {"tiles": len(coords), "tileBytes": tile_bytes, "dropped": {}}

    out_lines = {}
    for cls, parts in lines.items():
        out = []
        if parts:
            merged = shapely.line_merge(_round_lines(parts))
            for ln in _explode(merged, "LineString"):
                if ln.length < min_len:
                    stats["dropped"][f"{cls} short"] = stats["dropped"].get(f"{cls} short", 0) + 1
                    continue
                s = ln.simplify(max(params["lineToleranceM"], 0.4 * px_m), preserve_topology=False)
                c = list(s.coords)
                if len(c) >= 2:
                    out.append(c)
        out_lines[cls] = out

    out_polys = {}
    view_area = W * H
    for cls, parts in polys.items():
        groups = [parts]
        if cls == "park" and protected:
            merged_p = shapely.union_all(protected, grid_size=0.01)
            keep = [p for p in _explode(merged_p, "Polygon") if p.area <= params["maxProtectedAreaFraction"] * view_area]
            dropped = len(_explode(merged_p, "Polygon")) - len(keep)
            if dropped:
                stats["dropped"]["park (protected area too large)"] = dropped
            groups.append(keep)
        out = []
        for group in groups:
            if not group:
                continue
            merged = shapely.union_all(group, grid_size=0.01).intersection(view_box)
            for p in _explode(merged, "Polygon"):
                p = p.simplify(max(params["polygonToleranceM"], 0.5 * px_m), preserve_topology=True)
                for q in _explode(p, "Polygon"):
                    if q.exterior is None or abs(shapely.area(shapely.Polygon(q.exterior))) < min_area:
                        continue
                    rings = [list(q.exterior.coords)[:-1]]
                    for hole in q.interiors:
                        if shapely.Polygon(hole).area >= min_area:
                            rings.append(list(hole.coords)[:-1])
                    out.append((rings, q.area))
        out.sort(key=lambda r: -r[1])
        out_polys[cls] = out
    return out_lines, out_polys, stats


def _round_lines(parts):
    """Rounds to 1 cm so tile-boundary end points from neighbouring tiles coincide exactly."""
    flat = []
    for g in parts:
        flat.extend(_explode(g, "LineString"))
    ml = shapely.MultiLineString(flat) if flat else shapely.MultiLineString([])
    return shapely.transform(ml, lambda c: np.round(c, 2))


def _explode(g, typ):
    if g is None or g.is_empty:
        return []
    if g.geom_type == typ:
        return [g]
    if hasattr(g, "geoms"):
        out = []
        for sub in g.geoms:
            out.extend(_explode(sub, typ))
        return out
    return []
