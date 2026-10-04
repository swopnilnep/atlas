"""Elevation grid from AWS Terrain Tiles (Terrarium PNG encoding).

elevation_m = (R * 256 + G + B / 256) - 32768
"""

import io
import math
import os
import time
import urllib.request

import numpy as np
from PIL import Image

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
USER_AGENT = "Atlas data preparation (https://atlas.swopnil.com; local one-off build)"


def lonlat_to_pixel(lon, lat, z):
    """Global Web Mercator pixel coordinates (256 px tiles)."""
    n = 2**z * 256
    x = (lon + 180.0) / 360.0 * n
    lr = math.radians(lat)
    y = (1.0 - math.log(math.tan(lr) + 1.0 / math.cos(lr)) / math.pi) / 2.0 * n
    return x, y


def fetch_tile(cache_dir, z, x, y, log=print):
    path = os.path.join(cache_dir, str(z), str(x), f"{y}.png")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        url = TILE_URL.format(z=z, x=x, y=y)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = r.read()
                break
            except Exception as exc:  # noqa: BLE001
                if attempt == 3:
                    raise
                log(f"  retry {url}: {exc}")
                time.sleep(2 * (attempt + 1))
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        time.sleep(0.1)  # be polite: sequential with a short pause
    img = Image.open(path).convert("RGB")
    a = np.asarray(img, dtype=np.float64)
    return a[:, :, 0] * 256 + a[:, :, 1] + a[:, :, 2] / 256 - 32768


SPIKE_M = 100.0


def despike(a, iterations=3):
    """Replace isolated pixels that are more than SPIKE_M lower (or higher)
    than all 8 neighbours with the median of those neighbours. The tiles
    contain a few such single-pixel pits (e.g. -2400 m on land near Seattle)."""
    total = 0
    for _ in range(iterations):
        p = np.pad(a, 1, mode="edge")
        h, w = a.shape
        nb = np.stack([p[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
                       for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx])
        low = a < nb.min(axis=0) - SPIKE_M
        high = a > nb.max(axis=0) + SPIKE_M
        bad = low | high
        n = int(bad.sum())
        if not n:
            break
        a = np.where(bad, np.median(nb, axis=0), a)
        total += n
    return a, total


def elevation_grid(bounds, columns, zoom, cache_dir, kx_over_ky, log=print):
    """Bilinear-sample a grid of `columns` x rows cell centres covering bounds.

    rows = round(columns * height_m / width_m) using the local equirectangular
    approximation. Row 0 is the NORTH edge, column 0 the WEST edge. Cell (r, c)
    is sampled at lon = w + (c + 0.5) / C * (e - w), lat = n - (r + 0.5) / R * (n - s).
    """
    w, s, e, n = bounds
    rows = round(columns * (n - s) / ((e - w) * kx_over_ky))
    lons = w + (np.arange(columns) + 0.5) / columns * (e - w)
    lats = n - (np.arange(rows) + 0.5) / rows * (n - s)
    px = np.array([lonlat_to_pixel(lo, lats[0], zoom)[0] for lo in lons]) - 0.5
    py = np.array([lonlat_to_pixel(lons[0], la, zoom)[1] for la in lats]) - 0.5

    x_lo, x_hi = int(math.floor(px.min())) - 1, int(math.floor(px.max())) + 2
    y_lo, y_hi = int(math.floor(py.min())) - 1, int(math.floor(py.max())) + 2
    tx0, tx1 = x_lo // 256, x_hi // 256
    ty0, ty1 = y_lo // 256, y_hi // 256
    count = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
    log(f"  elevation: zoom {zoom}, tiles x {tx0}..{tx1}, y {ty0}..{ty1} ({count} tiles)")
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256))
    from concurrent.futures import ThreadPoolExecutor

    coords = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
    with ThreadPoolExecutor(12) as ex:
        tiles = list(ex.map(lambda c: fetch_tile(cache_dir, zoom, c[0], c[1], log), coords))
    for (tx, ty), t in zip(coords, tiles):
        mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = t
    mosaic, spikes = despike(mosaic)
    log(f"  elevation: replaced {spikes} spike pixels (> {SPIKE_M} m below or above all 8 neighbours)")
    gx = px - tx0 * 256
    gy = py - ty0 * 256
    ix = np.floor(gx).astype(int)
    iy = np.floor(gy).astype(int)
    fx = gx - ix
    fy = gy - iy
    X0, Y0 = np.meshgrid(ix, iy)
    FX, FY = np.meshgrid(fx, fy)
    v = (
        mosaic[Y0, X0] * (1 - FX) * (1 - FY)
        + mosaic[Y0, X0 + 1] * FX * (1 - FY)
        + mosaic[Y0 + 1, X0] * (1 - FX) * FY
        + mosaic[Y0 + 1, X0 + 1] * FX * FY
    )
    src_m = 156543.03392 * math.cos(math.radians((s + n) / 2)) / 2**zoom
    return v, rows, {"zoom": zoom, "tiles": count, "sourcePixelM": round(src_m, 1), "despikedPixels": spikes,
                     "despikeThresholdM": SPIKE_M, "sampling": "bilinear at cell centres"}


PIT_M = 300.0


def fill_pits(grid, threshold=PIT_M, iterations=2):
    """Replaces grid cells more than `threshold` m below the median of their 5 x 5 neighbourhood
    with that median. Catches multi-pixel voids (SRTM gaps in steep terrain) that despike() misses;
    a genuine shoreline or gorge cell has enough low neighbours to keep its median low."""
    from numpy.lib.stride_tricks import sliding_window_view

    total = 0
    g = grid.copy()
    for _ in range(iterations):
        med = np.median(sliding_window_view(np.pad(g, 2, mode="edge"), (5, 5)), axis=(-1, -2))
        bad = g < med - threshold
        n = int(bad.sum())
        if not n:
            break
        g[bad] = med[bad]
        total += n
    return g, total
