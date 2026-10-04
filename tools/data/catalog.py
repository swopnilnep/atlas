"""The Atlas piece catalog (views/catalog.json) and per-piece processing parameters.

Bounds are a 16:10 rectangle (width = widthKm, height = widthKm * 10 / 16) centred on `center`
[lon, lat] in the local equirectangular approximation the renderer uses (x scaled by
cos(centre latitude), sphere R = 6371008.8 m). tools/lib/catalog.mjs computes the same bounds.
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
CATALOG = os.path.join(ROOT, "views", "catalog.json")

EARTH_RADIUS_M = 6371008.8
M_PER_DEG = math.pi * EARTH_RADIUS_M / 180.0

ALL_ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "service"]
MAJOR_ROAD_CLASSES = ALL_ROAD_CLASSES[:5]
LINE_CLASSES = ALL_ROAD_CLASSES + ["rail", "river", "stream", "canal"]
POLYGON_CLASSES = ["water", "park", "wood", "glacier", "wetland"]

PARAMS = {
    "quant": 65535,
    "referenceOutputWidthPx": 3840,
    "lineToleranceM": 5.0,
    "polygonToleranceM": 8.0,
    "minLineLengthPx": 2.0,
    "minPolygonAreaPx2": 4.0,
    "maxProtectedAreaFraction": 0.3,
    "elevationClampBelowM": 0,
    # Protomaps zoom: minor roads (residential, unclassified, service) only appear at z14.
    "cityVectorZoom": 14,
    "contourVectorZoom": 13,
    # Wide contour fields (rifts, island chains) need fewer, coarser tiles.
    "contourVectorZoomAboveKm": {"60": 12, "100": 11},
    "ridgelineVectorZoom": 12,
    # Water Shapes pieces (deltas, atolls, reservoirs) are wide: water and wetlands only, from low-zoom tiles; no roads.
    "deltaVectorZoom": 11,
    "deltaVectorZoomAboveKm": {"160": 10},
    "deltaVectorZoomBelowKm": {"80": 12},
    "dropServiceAboveKm": 25,
    # Dense metros at >= this width drop residential if the total data budget is exceeded.
    "dropResidentialAtKm": None,
    "cityElevationColumns": 512,
    "terrainElevationColumns": 600,
}

US_STATES = {"Texas": "TX", "Washington": "WA", "California": "CA", "New York": "NY", "Pennsylvania": "PA",
             "Louisiana": "LA", "Alaska": "AK", "Arizona": "AZ", "Oregon": "OR"}
COUNTRY_CODES = {"China": "CN", "Nepal": "NP", "India": "IN", "Italy": "IT", "Netherlands": "NL", "Türkiye": "TR",
                 "Portugal": "PT", "Hungary": "HU", "Brazil": "BR", "South Africa": "ZA", "Nepal–China": "NP–CN",
                 "Pakistan–China": "PK–CN", "Nepal–India": "NP–IN", "Switzerland–Italy": "CH–IT",
                 "France–Italy": "FR–IT", "Tanzania": "TZ", "Japan": "JP", "Argentina": "AR",
                 "Bangladesh–India": "BD–IN", "Egypt": "EG", "Vietnam": "VN", "Russia": "RU", "Myanmar": "MM",
                 "Botswana": "BW", "Mexico": "MX", "Assam, India": "IN",
                 "Germany": "DE", "Spain": "ES", "France": "FR", "Norway": "NO", "Iceland": "IS", "Greece": "GR",
                 "Canada": "CA", "Thailand": "TH", "Mongolia": "MN", "Taiwan": "TW", "Kenya": "KE", "Ecuador": "EC",
                 "Mauritania": "MR", "Namibia": "NA", "Algeria": "DZ", "New Zealand": "NZ", "Maldives": "MV",
                 "Indonesia": "ID",
                 "Quebec, Canada": "CA", "Nunavut, Canada": "CA", "Tenerife, Spain": "ES", "Sumatra, Indonesia": "ID"}
EUROPE = {"Italy", "Netherlands", "Türkiye", "Portugal", "Hungary", "Switzerland–Italy", "France–Italy",
          "Germany", "Spain", "France", "Norway", "Iceland", "Greece"}

USGS_GLOBAL = "SRTM and GMTED2010 data courtesy of the U.S. Geological Survey"
USGS_US = "3DEP data courtesy of the U.S. Geological Survey"
EU_DEM = "Produced using Copernicus data and information funded by the European Union - EU-DEM layers"
JOERD_REQUIRED = [
    "ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;",
    "Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;",
    "Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;",
    "Canada terrain data contains information licensed under the Open Government Licence – Canada;",
    "Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers;",
    "Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration",
    "Mexico terrain data source: INEGI, Continental relief, 2016;",
    "New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved);",
    "Norway terrain data © Kartverket;",
    "United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved;",
    "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.",
]

OPTIONAL_FIELDS = ["peak", "nativeName", "nativeLang"]
FIELDS = ["id", "place", "view", "title", "region", "category", "style", "center", "widthKm", "defaultPalette", "summary"]


def rect_bounds(lat, lon, width_m, height_m):
    half_lat = (height_m / 2) / M_PER_DEG
    half_lon = (width_m / 2) / M_PER_DEG / math.cos(math.radians(lat))
    return [round(lon - half_lon, 5), round(lat - half_lat, 5), round(lon + half_lon, 5), round(lat + half_lat, 5)]


def piece_bounds(piece):
    lon, lat = piece["center"]
    w = piece["widthKm"] * 1000.0
    return rect_bounds(lat, lon, w, w * 10 / 16)


def load():
    with open(CATALOG) as f:
        doc = json.load(f)
    pieces = {}
    for p in doc["pieces"]:
        for k in FIELDS:
            if k not in p:
                raise ValueError(f"catalog: {p.get('id')} is missing {k}")
        if p["id"] != f"{p['place']}-{p['view']}":
            raise ValueError(f"catalog: id {p['id']} must be <place>-<view>")
        for k in p:
            if k not in FIELDS and k not in OPTIONAL_FIELDS:
                raise ValueError(f"catalog: {p['id']} has unknown field {k}")
        if p["id"] in pieces:
            raise ValueError(f"catalog: duplicate id {p['id']}")
        p = dict(p)
        p["bounds"] = piece_bounds(p)
        pieces[p["id"]] = p
    return pieces


def elevation_zoom(width_m, columns, lat):
    """Smallest Terrarium zoom whose source pixel is at most 2/3 of a grid cell (z10..z13)."""
    cell = width_m / columns
    for z in range(10, 14):
        if 156543.03392 * math.cos(math.radians(lat)) / 2**z <= cell / 1.5:
            return z
    return 13


def plan(piece):
    """Classes, zooms, and grid size for one piece."""
    lat = piece["center"][1]
    width_m = piece["widthKm"] * 1000.0
    if piece["style"] == "urban-relief":
        roads = list(ALL_ROAD_CLASSES)
        if piece["widthKm"] > PARAMS["dropServiceAboveKm"]:
            roads.remove("service")
        drop_res = PARAMS["dropResidentialAtKm"]
        if drop_res is not None and piece["widthKm"] >= drop_res:
            roads.remove("residential")
        lines = ["rail", "river", "stream", "canal"]
        polys = ["water", "park", "wood"]
        zoom = PARAMS["cityVectorZoom"]
        columns = PARAMS["cityElevationColumns"]
    elif piece["style"] == "water-shapes":
        roads, lines, polys = [], ["river", "stream", "canal"], ["water", "wetland"]
        zoom = PARAMS["deltaVectorZoom"]
        for km, z in PARAMS["deltaVectorZoomAboveKm"].items():
            if piece["widthKm"] >= float(km):
                zoom = z
        for km, z in PARAMS["deltaVectorZoomBelowKm"].items():
            if piece["widthKm"] < float(km):
                zoom = z
        columns = PARAMS["terrainElevationColumns"]
    elif piece["style"] == "contour-fields":
        roads, lines, polys = list(MAJOR_ROAD_CLASSES), ["river", "stream"], ["water", "glacier"]
        zoom = PARAMS["contourVectorZoom"]
        for km, z in PARAMS["contourVectorZoomAboveKm"].items():
            if piece["widthKm"] > float(km):
                zoom = min(zoom, z)
        columns = PARAMS["terrainElevationColumns"]
    else:
        roads, lines, polys = [], ["river"], ["water", "glacier"]
        zoom = PARAMS["ridgelineVectorZoom"]
        columns = PARAMS["terrainElevationColumns"]
    return {
        "roadClasses": roads, "lineClasses": lines, "polygonClasses": polys, "vectorZoom": zoom,
        "elevation": {"columns": columns, "zoom": elevation_zoom(width_m, columns, lat)},
    }


def region_code(region):
    return US_STATES.get(region) or COUNTRY_CODES.get(region) or region


def elevation_credit(region):
    if region in US_STATES:
        return USGS_US
    if region in EUROPE:
        return f"{EU_DEM}; {USGS_GLOBAL}"
    return USGS_GLOBAL


def required_attribution(region):
    if region in US_STATES:
        short = USGS_US
    elif region in EUROPE:
        short = "EU-DEM, produced using Copernicus data funded by the European Union; " + USGS_GLOBAL
    else:
        short = USGS_GLOBAL
    return f"© OpenStreetMap contributors · Protomaps · Elevation: {short}"
