# -*- coding: utf-8 -*-
"""
make_glass_table.py  --  build the CODE V -> Zemax glass name/catalog map
that CV2ZMX.seq uses (CV2ZMX_GLASS.DAT).

Reads
  * CODE V material catalogs  <CODEV>/glass/*.xml        (CODE V spelling, no hyphens)
  * Zemax glass catalogs      <ZEMAXDATA>/Glasscat/*.AGF (Zemax spelling, with hyphens)

A CODE V glass is matched to a Zemax glass by "normalised name" -- upper case
with  -  _  .  and blanks removed -- which is exactly the transformation CODE V
applies when it imports a vendor catalogue (CODE V glass names cannot contain a
hyphen, Zemax names can).

Writes CV2ZMX_GLASS.DAT: pure data, five blank separated fields per line,
no header and no comment lines, because CV2ZMX.seq reads it with an
unformatted REA (blanks are the field delimiter, and a comment line would
break the two numeric fields):

    <CODEV_NAME>_<CODEV_CAT>  <ZEMAX_NAME>  <ZEMAX_CATALOG>  <nd>  <vd>

Field 1 is exactly  concat((GLA Sk),"_",(GLA Sk CAT))  in CODE V, so the macro
can compare strings without parsing anything.

Re-run this whenever either side's catalogues are updated.
"""

import os
import re
import glob

CODEV_GLASS = r"E:\Download\20macro\CODEV2026\glass"
ZEMAX_GLASS = r"C:\Users\T1791\Documents\Zemax\Glasscat"
OUT = r"E:\Download\cv2zmx\CV2ZMX_GLASS.DAT"

# CODE V catalogue -> preferred Zemax catalogue(s), best first.  A glass is
# looked for in each in turn, so a discontinued glass can still be picked up
# from an older catalogue file; the catalogue that actually supplied it is
# what lands in the table and therefore in the .zmx GCAT line.
CAT_MAP = {
    "CDGM":       ["CDGM2025011", "CDGM-ZEMAX202309", "CDGM"],
    "HOYA":       ["HOYA20260707", "HOYA20251120", "HOYA20230822", "HOYA"],
    "OHARA":      ["OHARA_240131", "OHARA_230808", "OHARA"],
    "SCHOTT":     ["SCHOTT"],
    "HIKARI":     ["NIKON-HIKARI20220701", "NIKON-HIKARI", "HIKARI"],
    "SUMITA":     ["Sumita"],
    "NHG":        ["NHG"],
    "NIKON":      ["NIKON"],
    "CORNING":    ["CORNING"],
    "HERAEUS":    ["HERAEUS"],
    "ZEON":       ["ZEON"],
    "PILKINGTON": ["PILKINGTON"],
    "MITSUI":     ["MISC"],
    "OSAKA":      ["OSAKAGASCHEMICAL", "MISC"],
    "KODAK":      ["MISC"],
    "CHANCE":     ["MISC"],
    "CHINA":      ["MISC"],
    "CORNFR":     ["CORNING", "MISC"],
    "NSG":        ["MISC"],
    "SPECIAL":    ["MISC", "INFRARED"],
}


def norm(s):
    return re.sub(r"[-_.\s]", "", s).upper()


def read_text(path):
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def load_agf(path):
    """-> {normalised_name: (zemax_name, nd, vd)}"""
    out = {}
    for line in read_text(path).splitlines():
        line = line.strip()
        if not line.startswith("NM "):
            continue
        p = line.split()
        if len(p) < 6:
            continue
        name = p[1]
        try:
            nd, vd = float(p[4]), float(p[5])
        except ValueError:
            nd, vd = 0.0, 0.0
        out.setdefault(norm(name), (name, nd, vd))
    return out


def load_codev_xml(path):
    return re.findall(r"<GlassName>([^<]*)</GlassName>", read_text(path))


def find_agf(catname):
    for ext in (".AGF", ".agf"):
        p = os.path.join(ZEMAX_GLASS, catname + ext)
        if os.path.exists(p):
            return p
    for p in glob.glob(os.path.join(ZEMAX_GLASS, "*.[aA][gG][fF]")):
        if os.path.splitext(os.path.basename(p))[0].upper() == catname.upper():
            return p
    return None


def main():
    agf_cache = {}
    records = []
    missing = []

    for xml in sorted(glob.glob(os.path.join(CODEV_GLASS, "*.xml"))):
        cv_cat = os.path.splitext(os.path.basename(xml))[0].upper()
        zcats = CAT_MAP.get(cv_cat)
        if not zcats:
            continue
        names = load_codev_xml(xml)
        for zc in zcats:
            if zc not in agf_cache:
                p = find_agf(zc)
                if not p:
                    print("  ! no Zemax catalog file for %s" % zc)
                agf_cache[zc] = load_agf(p) if p else {}
        hit = 0
        for cvn in names:
            key = norm(cvn)
            for zc in zcats:
                g = agf_cache[zc].get(key)
                if g:
                    records.append((cvn + "_" + cv_cat, g[0], zc, g[1], g[2]))
                    hit += 1
                    break
            else:
                missing.append(cvn + "_" + cv_cat)
        print("%-12s %4d/%4d matched  -> %s" % (cv_cat, hit, len(names), zcats[0]))

    with open(OUT, "w", newline="\r\n") as f:
        for r in records:
            f.write("%s %s %s %.6f %.4f\n" % r)

    print("\n%d records -> %s" % (len(records), OUT))
    print("%d CODE V glasses had no Zemax counterpart" % len(missing))
    if missing:
        with open(OUT.replace(".DAT", "_UNMATCHED.txt"), "w", newline="\r\n") as f:
            f.write("\n".join(missing))


if __name__ == "__main__":
    main()
