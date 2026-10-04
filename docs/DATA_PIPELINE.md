# Atlas Data Pipeline

This pipeline turns OpenStreetMap data (via the Protomaps planet tiles) and public elevation tiles into one small JSON file per piece. The browser renderer draws artwork from these files. It runs on a laptop, needs no accounts or API keys, and works for any place on Earth.

Code: `tools/data/`. Input: `views/catalog.json`. Output: `public/data/<id>-v1.json` and `<id>-v1.manifest.json`.

## Adding a place

Add one entry to `views/catalog.json` and run the pipeline, then the previews:

```jsonc
{ "id": "lima-metro", "place": "lima", "view": "metro", "title": "Lima", "region": "Peru",
  "category": "cities", "style": "urban-relief", "center": [-77.04, -12.06], "widthKm": 30,
  "defaultPalette": "paper", "summary": "One plain factual line.",
  "peak": { "name": "…", "elevationM": 0 } }        // optional, ridgelines annotation
```

```sh
.venv/bin/python tools/data/prepare.py all    # idempotent: skips pieces whose outputs exist (--force rebuilds)
npm run render:curated -- lima-metro          # one 1280 × 800 WebP in the default palette
npm run build && npm run validate:build
```

Bounds are a 16:10 rectangle, `widthKm` × `widthKm / 1.6`, centred on `center` in the local equirectangular approximation (sphere R = 6,371,008.8 m; lon span = width / (111,195 m × cos lat)). `tools/data/catalog.py` and `tools/lib/catalog.mjs` compute the same bounds (a test checks they agree with every data file). Pages are generated from the catalog directly; a piece is `published` once its data file exists. Optional page text (subtitle, notes) goes in `views/notes/<id>.json`. `prepare.py` continues past a failing piece and lists failures at the end. If a region name is new, add its code and elevation credit bucket in `catalog.py` (`US_STATES`, `COUNTRY_CODES`, `EUROPE`).

## Sources and licenses

| Source | What we use | License | Credit |
| --- | --- | --- | --- |
| Protomaps basemap, daily planet build (`https://build.protomaps.com/<key>`, key = last entry of `https://build-metadata.protomaps.dev/builds.json`), read with HTTP range requests | Roads, rail, rivers/streams/canals, water incl. ocean, parks, woods, glaciers | OpenStreetMap data, ODbL 1.0 | `© OpenStreetMap contributors`, Protomaps |
| AWS Terrain Tiles (Tilezen Joerd), Terrarium PNG | Elevation grid | Mixed open sources (3DEP, SRTM, GMTED2010, ETOPO1, EU-DEM, …) | Joerd attribution list |

The build key is pinned in `data/raw/protomaps/build.json` so reruns use the same build and tile cache (`data/raw/protomaps/<key>/z/x/y.mvt`); `--refresh-osm` re-pins the latest. Each manifest records the build, basemap version, zoom, tile count, the full Joerd required-attribution list, and a short `requiredAttribution` naming the elevation sources for that region (3DEP for US states; EU-DEM + SRTM for Europe; SRTM/GMTED2010 elsewhere).

**Attribution and ODbL.** Images carry no credit line. Attribution for a downloaded PNG is in its metadata (tEXt `Source`, `Copyright`), on the piece's page next to the download button, in the footer, and on `/sources/`. That page-plus-metadata credit is how the ODbL attribution requirement is met for downloads.

Raw downloads stay in `data/raw/` (git-ignored).

## Steps

1. **Tiles.** Zoom 14 for cities (minor roads — residential, unclassified, service — exist only at z14; z13 tiles carry almost none), 13 for contour-fields, 12 for ridgelines (no roads). Tiles are fetched in parallel (16 threads) and cached. Directory ranges are memoized.
2. **Classes** (`tools/data/protomaps_classes.json`): roads by `kind_detail` (`*_link` → parent; `unclassified`, `living_street` → residential; `rail`, `light_rail` → rail; paths, ferries, subways dropped); water lines by `kind` (river, stream, canal); every water polygon (incl. `ocean`, so the sea is filled) except pools and fountains; landuse park/national_park/nature_reserve/protected_area/garden/recreation_ground → park, forest/wood → wood, glacier → glacier. `service` roads are dropped for views wider than 25 km.
3. **Merge.** Each tile's features are projected to local metres and clipped to the tile's own extent (no buffer). Lines are rounded to 1 cm and joined end to end (`shapely.line_merge`); polygons are unioned per class (protected areas separately; a merged protected area over 30% of the view is dropped).
4. **Clip, simplify, quantize** exactly as before (5 m lines, 8 m polygons, 2 px minimum length, (2 px)² minimum ring).
5. **Elevation.** Terrarium tiles at the smallest zoom whose pixel ≤ ⅔ of a grid cell (z10–13); 512 columns for cities, 600 for terrain. Single-pixel spikes are replaced, then multi-cell voids (> 300 m below the 5 × 5 median, common in Himalayan SRTM) are filled; values below 0 m are clamped.
6. **Check** (`check.py`; a failing piece is not written), **write** JSON and manifest.

The previous Geofabrik/pyosmium path is kept in `tools/data/legacy/` for comparison; the three original views were regenerated with the Protomaps path (equal or better: same classes, ocean filled directly, 16:10 framing).

## Output format (contract)

One compact JSON file per view (no whitespace), `public/data/<view-id>-v1.json`. Keys appear in this order:

```jsonc
{
  "version": 2,
  "id": "austin-metro",
  "bounds": [-98.01, 30.16, -97.49, 30.44],     // [west, south, east, north], WGS84 degrees
  "quant": 65535,
  "lines": {
    "motorway": [...], "trunk": [...], "primary": [...], "secondary": [...], "tertiary": [...],
    "residential": [...], "service": [...], "rail": [...], "river": [...], "stream": [...], "canal": [...]
  },
  "polygons": { "water": [...], "park": [...], "wood": [...], "glacier": [...] },
  "elevation": { "columns": 512, "rows": 319, "min": 110, "max": 385, "values": [...] },
  "label": { "name": "Austin", "region": "Texas", "regionCode": "TX", "source": "OSM node 1801308037 (place=city); region from OSM relation 114690 (ISO3166-2=US-TX)" }
}
```

**Coordinates.** Integers on a 0..quant grid on both axes:

```text
qx = round((lon - west)  / (east - west)  * quant)
qy = round((lat - south) / (north - south) * quant)     y grows NORTH
lon = west  + qx / quant * (east - west)
lat = south + qy / quant * (north - south)
```

The x and y steps differ in metres. To draw, map qx to `[0, width]` and qy to `[height, 0]`, with `height = width * (north - south) / ((east - west) * cos(centre latitude))`.

**Lines.** `lines[class]` is an array of lines. Each line is a flat integer array: the first point is absolute and every later point is a delta from the one before.

```text
[qx0, qy0, dx1, dy1, dx2, dy2, ...]   ->   x1 = qx0 + dx1, y1 = qy0 + dy1, x2 = x1 + dx2, ...
```

Every line has at least 2 points. All classes are always present. A class may be an empty array, for example `canal` in Austin or `service` on Rainier.

**Polygons.** `polygons[class]` is an array of polygons. Each polygon is an array of rings, and each ring is delta-encoded like a line. Rings are **not** explicitly closed: the last point does not repeat the first, so close the path when drawing. A ring has at least 3 points. One polygon may contain several outer rings and holes from one OSM multipolygon, plus islands for the sea, so **fill each polygon with the even-odd rule**. Ring winding is not normalized. Polygons of the same class may overlap. For example, `natural=bay` polygons lie on top of the coastline sea, so draw each class with one solid colour, not translucent.

**Elevation.** Integer metres, row-major. Row 0 is the NORTH edge and column 0 the WEST edge. The grid cells tile the bounds exactly, and each value is sampled at the cell centre:

```text
lon(c) = west  + (c + 0.5) / columns * (east - west)
lat(r) = north - (r + 0.5) / rows    * (north - south)
value(r, c) = values[r * columns + c]
```

`min` and `max` are the minimum and maximum of `values`.

**Label.** For catalog pieces `name` and `region` come from the catalog (`title`, `region`) and `source` is `views/catalog.json`; optional `summit: { name, elevationM }` comes from `peak` and is drawn by the ridgelines style. (Legacy files: `name` came from the OSM `place=city` node in the view (closest to the centre, then by population). For a peak view it comes from the summit `natural=peak` node. `region` and `regionCode` come from the US state boundary relation containing that node (`ISO3166-2=US-TX` → `TX`). `source` names the OSM objects used. On Rainier the summit node is named "Columbia Crest" and carries `massif:name=Mount Rainier`, so the label uses `massif:name`.)

Tiny example: one residential street with three points and one triangular lake.

```json
{"version":2,"id":"example","bounds":[0,0,1,1],"quant":65535,
 "lines":{"motorway":[],"trunk":[],"primary":[],"secondary":[],"tertiary":[],"residential":[[100,200,50,0,0,-30]],"service":[],"rail":[],"river":[],"stream":[],"canal":[]},
 "polygons":{"water":[[[1000,1000,500,0,-250,400]]],"park":[],"wood":[],"glacier":[]},
 "elevation":{"columns":2,"rows":1,"min":5,"max":9,"values":[5,9]},
 "label":{"name":"X","region":"Y","regionCode":"YY","source":"OSM node 1 (place=city)"}}
```

The street points are (100,200), (150,200), and (150,170). The lake points are (1000,1000), (1500,1000), and (1250,1400).

## Sizes (build 20261004)

35 pieces, 48.9 MB raw JSON in `public/data/` (largest: Austin 3.7 MB raw / 1.4 MB gzip). All under the 3 MB gzip budget, so no residential dropping was needed (`PARAMS["dropResidentialAtKm"]` stays off). A full first run takes about 6 minutes; a rerun skips everything in under a second.

## Known limitations

- The data is a snapshot. Rerunning on a newer extract changes the output.
- Tunnels and bridges are not distinguished. Roads in tunnels are drawn like surface roads.
- Polygons clipped at the view border get straight edges along it.
- Lake Travis is cut by the west edge of the Austin view: only 33 km² of the lake is inside.
- Rivers have both a polygon (`water`, from riverbanks) and a centre line (`river`). The renderer decides whether to draw both.
- Polygon names are not kept after the cross-tile union; manifests list the largest areas only.
- Protomaps tiles are generalized per zoom level; a few very small features in OSM may be missing.
- Elevation is resampled from Web Mercator tiles to a coarse grid. It is meant for artistic hillshade and contours, not analysis. GitHub Pages compression may differ slightly from the gzip size measured here.
