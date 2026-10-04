#!/usr/bin/env python3
"""Contact sheets of the published previews (downscaled JPEG, <= 1600 px wide).

    .venv/bin/python tools/data/contact_sheet.py <out-dir>
Writes <out-dir>/<section>.jpg (cities, terrain, hydrology, coasts, formations) from public/artwork/<id>-<defaultPalette>.webp.
"""

import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import catalog  # noqa: E402

WIDTH = 1560
GAP = 6
CAPTION = 16


def sheet(pieces, columns, path):
    tile_w = (WIDTH - GAP * (columns + 1)) // columns
    tile_h = tile_w * 10 // 16
    rows = (len(pieces) + columns - 1) // columns
    img = Image.new("RGB", (WIDTH, GAP + rows * (tile_h + CAPTION + GAP)), (128, 128, 128))
    draw = ImageDraw.Draw(img)
    for i, p in enumerate(pieces):
        x = GAP + (i % columns) * (tile_w + GAP)
        y = GAP + (i // columns) * (tile_h + CAPTION + GAP)
        src = os.path.join(catalog.ROOT, "public", "artwork", f"{p['id']}-{p['defaultPalette']}.webp")
        if os.path.exists(src):
            with Image.open(src) as t:
                img.paste(t.convert("RGB").resize((tile_w, tile_h), Image.LANCZOS), (x, y))
        else:
            draw.rectangle([x, y, x + tile_w, y + tile_h], fill=(200, 0, 0))
        draw.text((x + 2, y + tile_h + 2), f"{p['id']} · {p['defaultPalette']} · {p['widthKm']} km", fill=(255, 255, 255))
    img.save(path, "JPEG", quality=80, optimize=True)
    return path, os.path.getsize(path), img.size


def main(argv):
    out = argv[0] if argv else "."
    os.makedirs(out, exist_ok=True)
    pieces = list(catalog.load().values())
    for name, cols in (("cities", 6), ("terrain", 6), ("hydrology", 4), ("coasts", 4), ("formations", 4)):
        path, size, dims = sheet([p for p in pieces if p["category"] == name], cols, os.path.join(out, f"{name}.jpg"))
        print(f"{path}: {dims[0]}x{dims[1]}, {size / 1e6:.2f} MB")


if __name__ == "__main__":
    main(sys.argv[1:])
