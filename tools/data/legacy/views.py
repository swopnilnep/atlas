"""View definitions for the Atlas data pipeline.

Each view is one rectangle on the map, prepared into one compact JSON file.
Bounds are [west, south, east, north] in WGS84 degrees.
"""

import math

EARTH_RADIUS_M = 6371008.8
M_PER_DEG = math.pi * EARTH_RADIUS_M / 180.0  # ~111195 m per degree on a sphere

GEOFABRIK = "https://download.geofabrik.de/north-america/us/{state}-latest.osm.pbf"

ALL_ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "service"]
LINE_CLASSES = ALL_ROAD_CLASSES + ["rail", "river", "stream", "canal"]
POLYGON_CLASSES = ["water", "park", "wood", "glacier"]


def rect_bounds(lat, lon, width_m, height_m):
    """A width_m x height_m rectangle centred on (lat, lon) in the local
    equirectangular approximation used by the renderer (x scaled by cos(lat))."""
    half_lat = (height_m / 2) / M_PER_DEG
    half_lon = (width_m / 2) / M_PER_DEG / math.cos(math.radians(lat))
    return [round(lon - half_lon, 5), round(lat - half_lat, 5), round(lon + half_lon, 5), round(lat + half_lat, 5)]


def square_bounds(lat, lon, side_m):
    """A square of side_m metres centred on (lat, lon)."""
    return rect_bounds(lat, lon, side_m, side_m)


VIEWS = {
    "austin-metro": {
        "state": "texas",
        "bounds": [-98.01, 30.16, -97.49, 30.44],
        "scale": "metro",
        "roadClasses": ALL_ROAD_CLASSES,
        "lineClasses": ["rail", "river", "stream", "canal"],
        "polygonClasses": ["water", "park", "wood"],
        "elevation": {"columns": 512, "zoom": 11},
        "label": {"kind": "place", "place": ["city"], "fallbackName": "Austin"},
        "expectWater": ["Lady Bird Lake", "Lake Travis", "Lake Austin"],
        "expectElevation": [100, 420],
        "coastline": False,
    },
    "seattle-metro": {
        "state": "washington",
        "bounds": [-122.62, 47.46, -122.02, 47.76],
        "scale": "metro",
        "roadClasses": ALL_ROAD_CLASSES,
        "lineClasses": ["rail", "river", "stream", "canal"],
        "polygonClasses": ["water", "park", "wood"],
        "elevation": {"columns": 512, "zoom": 11},
        "label": {"kind": "place", "place": ["city"], "fallbackName": "Seattle"},
        "expectWater": ["Lake Washington", "Lake Union", "Puget Sound (coastline sea)"],
        "expectElevation": [0, 1000],
        "coastline": True,
    },
    "mount-rainier-summit": {
        "state": "washington",
        # 16:10 like the wallpapers, so nothing is cropped: 48 km wide x 30 km tall.
        "bounds": rect_bounds(46.853, -121.760, 48000, 30000),
        "center": [46.853, -121.760],
        "widthMeters": 48000,
        "heightMeters": 30000,
        "scale": "terrain",
        "roadClasses": ["motorway", "trunk", "primary", "secondary", "tertiary"],
        "lineClasses": ["river", "stream"],
        "polygonClasses": ["water", "glacier"],
        "elevation": {"columns": 600, "zoom": 12},
        "label": {"kind": "peak", "name": "Mount Rainier"},
        "expectWater": [],
        "expectGlacier": ["Emmons Glacier", "Nisqually Glacier"],
        "expectElevation": [300, 4400],  # the 48 km frame reaches lower valleys (387 m) than the old 30 km square
        "expectMaxAtLeast": 4300,
        "coastline": False,
    },
}

# Simplification and filtering parameters (see docs/DATA_PIPELINE.md).
PARAMS = {
    "quant": 65535,
    "referenceOutputWidthPx": 3840,
    "lineToleranceM": 5.0,
    "polygonToleranceM": 8.0,
    "minLineLengthPx": 2.0,
    "minPolygonAreaPx2": 4.0,  # (2 px)^2
    "maxProtectedAreaFraction": 0.3,  # national_park / protected_area polygons larger than this share of the view are dropped
    "extractBufferDeg": 0.03,
    "elevationClampBelowM": 0,  # sea-floor (bathymetry) values below 0 m are clamped to 0 m
}
