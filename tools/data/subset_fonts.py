#!/usr/bin/env python3
"""Subsets the bundled label fonts to exactly the characters the catalog uses.

Usage:
    .venv/bin/python tools/data/subset_fonts.py

Reads views/catalog.json (nativeName, title, region), groups the characters by script with the
same ranges and CJK-by-language rule as src/render/label.ts (SCRIPT_FONTS), downloads the source
fonts once from the google/fonts repository (SIL Open Font License 1.1, cached in
data/raw/fonts/), pins variable axes (wght 600, wdth 100), subsets with fontTools (pyftsubset's
library), and writes public/fonts/<file>-<weight>.woff2 plus public/fonts/Noto-OFL.txt.
Scripts no catalog name uses get no file (the renderer then falls back to system fonts).
"""

import io
import json
import os
import sys

import requests
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import catalog  # noqa: E402

ROOT = catalog.ROOT
CACHE = os.path.join(ROOT, "data", "raw", "fonts")
OUT = os.path.join(ROOT, "public", "fonts")
RAW = "https://raw.githubusercontent.com/google/fonts/main/ofl"

# file stem -> (google/fonts directory, source file, weights, codepoint ranges, CJK variant or None)
LATIN_EXT = [(0x0100, 0x02FF), (0x0370, 0x03FF), (0x0400, 0x04FF), (0x1E00, 0x1EFF)]
CJK = [(0x3000, 0x9FFF)]
FONTS = {
    "inter-ext": ("inter", "Inter[opsz,wght].ttf", ["400", "600"], LATIN_EXT, None),
    "noto-tibetan": ("notoseriftibetan", "NotoSerifTibetan[wght].ttf", ["600"], [(0x0F00, 0x0FFF)], None),
    "noto-devanagari": ("notosansdevanagari", "NotoSansDevanagari[wdth,wght].ttf", ["600"], [(0x0900, 0x097F)], None),
    "noto-bengali": ("notosansbengali", "NotoSansBengali[wdth,wght].ttf", ["600"], [(0x0980, 0x09FF)], None),
    "noto-thai": ("notosansthai", "NotoSansThai[wdth,wght].ttf", ["600"], [(0x0E00, 0x0E7F)], None),
    "noto-myanmar": ("notosansmyanmar", "NotoSansMyanmar[wdth,wght].ttf", ["600"], [(0x1000, 0x109F)], None),
    "noto-arabic": ("notosansarabic", "NotoSansArabic[wdth,wght].ttf", ["600"],
                    [(0x0600, 0x06FF), (0x0750, 0x077F), (0xFB50, 0xFDFF), (0xFE70, 0xFEFF)], None),
    "noto-cjk-sc": ("notosanssc", "NotoSansSC[wght].ttf", ["600"], CJK, "sc"),
    "noto-cjk-tc": ("notosanstc", "NotoSansTC[wght].ttf", ["600"], CJK, "tc"),
    "noto-cjk-jp": ("notosansjp", "NotoSansJP[wght].ttf", ["600"], CJK, "ja"),
}
# Shaping helpers kept with every non-Latin subset (joiners, dotted circle for stray marks).
EXTRA = [0x200C, 0x200D, 0x25CC, 0x0020]


def cjk_variant(lang):
    lang = (lang or "").lower()
    if lang.startswith("ja"):
        return "ja"
    if "hant" in lang or lang.endswith(("-tw", "-hk", "-mo")):
        return "tc"
    return "sc"


def in_ranges(ch, ranges):
    return any(a <= ord(ch) <= b for a, b in ranges)


def wanted():
    """file stem -> set of characters from the catalog."""
    chars = {stem: set() for stem in FONTS}
    with open(catalog.CATALOG, encoding="utf-8") as f:
        pieces = json.load(f)["pieces"]
    for p in pieces:
        native = p.get("nativeName", p["title"])
        # Latin titles are drawn upper-case, so both cases are needed.
        texts = [native, native.upper(), p["title"], p["title"].upper(), p["region"], p["region"].upper()]
        variant = cjk_variant(p.get("nativeLang"))
        for text in texts:
            for ch in text:
                for stem, (_, _, _, ranges, cjk) in FONTS.items():
                    if in_ranges(ch, ranges) and (cjk is None or (cjk == variant and text in (native, native.upper()))):
                        chars[stem].add(ch)
    return chars


def source(directory, name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        r = requests.get(f"{RAW}/{directory}/{name}", timeout=300)
        r.raise_for_status()
        with open(path, "wb") as f:
            f.write(r.content)
    lic = os.path.join(CACHE, f"{directory}-OFL.txt")
    if not os.path.exists(lic):
        r = requests.get(f"{RAW}/{directory}/OFL.txt", timeout=60)
        r.raise_for_status()
        with open(lic, "w", encoding="utf-8") as f:
            f.write(r.text)
    return path, lic


def build(path, weight, chars):
    font = TTFont(path)
    if "fvar" in font:
        axes = {a.axisTag: a for a in font["fvar"].axes}
        pins = {}
        for tag, a in axes.items():
            value = float(weight) if tag == "wght" else 100.0 if tag == "wdth" else a.defaultValue
            pins[tag] = max(a.minValue, min(a.maxValue, value))
        font = instancer.instantiateVariableFont(font, pins, updateFontNames=False)
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.hinting = False
    options.desubroutinize = True
    sub = subset.Subsetter(options)
    sub.populate(unicodes=sorted({ord(c) for c in chars} | set(EXTRA)))
    sub.subset(font)
    buf = io.BytesIO()
    font.flavor = "woff2"
    font.save(buf)
    return buf.getvalue()


def main():
    chars = wanted()
    os.makedirs(OUT, exist_ok=True)
    licenses, total = {}, 0
    for stem, (directory, name, weights, _, _) in FONTS.items():
        for w in weights:
            out = os.path.join(OUT, f"{stem}-{w}.woff2")
            if not chars[stem]:
                if os.path.exists(out):
                    os.remove(out)
                continue
            path, lic = source(directory, name)
            data = build(path, w, chars[stem])
            with open(out, "wb") as f:
                f.write(data)
            total += len(data)
            licenses[directory] = lic
            print(f"{stem}-{w}.woff2: {len(chars[stem])} chars, {len(data):,} bytes")
    parts = []
    for directory, lic in sorted(licenses.items()):
        with open(lic, encoding="utf-8") as f:
            parts.append(f"=== {directory} (public/fonts subsets) ===\n\n{f.read().strip()}\n")
    with open(os.path.join(OUT, "Noto-OFL.txt"), "w", encoding="utf-8") as f:
        f.write("Subsets of open-license fonts from https://github.com/google/fonts, made by tools/data/subset_fonts.py.\n"
                "Each is licensed under the SIL Open Font License, Version 1.1 (below).\n\n" + "\n".join(parts))
    print(f"total {total:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
