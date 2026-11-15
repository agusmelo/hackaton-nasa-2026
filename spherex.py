"""SPHEREx data access: image search, per-frame reprojected cutouts, Gaia overlay, name resolution."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from astropy.coordinates import SkyCoord
import astropy.units as u
from astropy.io.votable import parse_single_table
from astropy.time import Time
from astropy.wcs import WCS

from fitsrange import RemoteSpherexImage

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
# Used only if the release list cannot be discovered (see collections()).
FALLBACK_COLLECTIONS = ["spherex_dr1", "spherex_dr1_deep", "spherex_qr3", "spherex_qr3_deep"]
BUCKET_LIST_URL = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/?list-type=2&delimiter=/"
PIXSCALE = 6.15  # arcsec / native SPHEREx pixel
CACHE = Path(os.environ.get("SPHEREX_CACHE", Path(__file__).parent / "cache"))
CACHE.mkdir(exist_ok=True)
(CACHE / "frames").mkdir(exist_ok=True)
(CACHE / "hdr").mkdir(exist_ok=True)

# Pixels never worth showing (dead, missing, onboard errors, cosmic-ray transients, hot/cold).
HARD_BAD = 1 | 2 | 4 | 64 | 512 | 1024 | 2048
# Flags reported as "contamination" near the target (shown to the user, not masked).
REPORT_FLAGS = {
    1: "TRANSIENT", 2: "OVERFLOW", 4: "SUR_ERROR", 64: "NONFUNC", 128: "DICHROIC", 512: "MISSING_DATA",
    1024: "HOT", 2048: "COLD", 16384: "PHANMISS", 32768: "NONLINEAR", 131072: "PERSIST", 524288: "OUTLIER",
    1048576: "CROSSTALK", 4194304: "GHOST", 8388608: "GHOST_FPA", 16777216: "GHOST_EXT", 33554432: "STREAK",
    67108864: "BLOOM", 134217728: "SNOWBALL", 268435456: "HALO",
}

UA = {"User-Agent": "spherex-motion-viewer/0.1 (prototype)"}


def _key(*parts) -> str:
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:20]


# ---------------------------------------------------------------- name resolution
def resolve(name: str) -> dict:
    """Resolve an object name via CDS Sesame (SIMBAD -> NED -> VizieR). Returns J2000 ICRS + proper motion."""
    r = requests.get(f"https://cds.unistra.fr/cgi-bin/nph-sesame/-ox/SNV?{requests.utils.quote(name)}",
                     timeout=30, headers=UA)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    res = root.find(".//Resolver")
    if res is None or res.find("jradeg") is None:
        raise ValueError(f"could not resolve '{name}'")
    g = lambda tag: (res.find(tag).text if res.find(tag) is not None else None)
    pm_ra = res.find("pm/pmRA")
    pm_de = res.find("pm/pmDE")
    return {
        "name": g("oname") or name,
        "ra": float(g("jradeg")), "dec": float(g("jdedeg")),
        "pmra": float(pm_ra.text) if pm_ra is not None else 0.0,  # mas/yr, includes cos(dec)
        "pmdec": float(pm_de.text) if pm_de is not None else 0.0,
        "epoch": 2000.0,
        "otype": g("otype"),
    }


def parse_coords(text: str) -> tuple[float, float] | None:
    """Accept '133.795 -7.245', '08h55m10.831s -07d14m42.53s', '08:55:10.8 -07:14:42'."""
    t = text.strip()
    try:
        parts = re.split(r"[\s,]+", t)
        if len(parts) == 2 and all(re.fullmatch(r"[+-]?\d+(\.\d*)?", p) for p in parts):
            return float(parts[0]), float(parts[1])
        c = SkyCoord(t, unit=(u.hourangle, u.deg))
        return float(c.ra.deg), float(c.dec.deg)
    except Exception:
        return None


def propagate(ra, dec, pmra, pmdec, epoch_from: float, epoch_to: float):
    """Linear proper-motion propagation (pmra includes cos dec), mas/yr."""
    dt = epoch_to - epoch_from
    dec2 = dec + pmdec * dt / 3.6e6
    ra2 = ra + pmra * dt / 3.6e6 / np.cos(np.radians(dec))
    return ra2, dec2


# ---------------------------------------------------------------- image search
def releases() -> dict:
    """Which SPHEREx data releases to search, found without editing this file when a new one comes out.

    NASA's public bucket holds one folder per release ("dr1/", "qr3/", ...). Every Data Release is used,
    plus the newest Quick Release (older Quick Releases are superseded). Each release has a wide-survey
    and a deep-field image collection at IRSA. SPHEREX_COLLECTIONS (comma-separated) overrides all this.
    """
    env = [c.strip() for c in os.environ.get("SPHEREX_COLLECTIONS", "").split(",") if c.strip()]
    if env:
        return {"collections": env, "releases": [], "source": "SPHEREX_COLLECTIONS"}
    ck = CACHE / "releases.json"
    if ck.exists() and time.time() - ck.stat().st_mtime < 12 * 3600:
        return json.loads(ck.read_text())
    try:
        r = requests.get(BUCKET_LIST_URL, timeout=20, headers=UA)
        r.raise_for_status()
        found = sorted({(k, int(n)) for k, n in re.findall(r"<Prefix>(dr|qr)(\d+)/</Prefix>", r.text)})
        drs = sorted((n for k, n in found if k == "dr"), reverse=True)
        qrs = sorted((n for k, n in found if k == "qr"), reverse=True)
        rel = [f"dr{n}" for n in drs] + ([f"qr{qrs[0]}"] if qrs else [])  # Data Releases first: preferred on duplicates
        if not rel:
            raise ValueError("no release folders found")
        out = {"collections": [c for x in rel for c in (f"spherex_{x}", f"spherex_{x}_deep")],
               "releases": [x.upper() for x in rel], "source": "NASA S3 bucket listing",
               "checked": Time.now().strftime("%Y-%m-%d %H:%M UTC")}
        ck.write_text(json.dumps(out))
        return out
    except Exception:
        if ck.exists():  # stale but real
            return json.loads(ck.read_text())
        return {"collections": FALLBACK_COLLECTIONS, "releases": ["DR1", "QR3"], "source": "built-in list"}


def collections() -> list[str]:
    return releases()["collections"]


def _sia_rows(coll: str, ra: float, dec: float):
    """Rows of one collection, or an Exception (returned, not raised, so one failure does not sink the rest)."""
    last = None
    for attempt in range(3):
        try:
            r = requests.get(SIA_URL, params={"COLLECTION": coll, "POS": f"circle {ra} {dec} 0.0005"},
                             timeout=180, headers=UA)
            if r.ok and r.content.lstrip().startswith(b"<?xml"):
                return parse_single_table(io.BytesIO(r.content)).to_table(use_names_over_ids=True)
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = type(e).__name__
        except Exception as e:  # an answer that is not a table
            last = type(e).__name__
        time.sleep(1.0 + attempt)
    return IOError(last or "no answer")


def _saved_image_list(ra: float, dec: float):
    """The image list saved for this position on an earlier search, if any: (frames, saved-when, partial)."""
    names = [("all",), tuple(collections()), ("spherex_dr1", "spherex_qr3")]  # current key, then the two older ones
    for extra in names:
        f = CACHE / f"sia_{_key(round(ra, 4), round(dec, 4), *extra)}.json"
        if not f.exists():
            continue
        try:
            d = json.loads(f.read_text())
        except ValueError:
            continue
        frames = d["frames"] if isinstance(d, dict) else d
        if frames:
            return frames, f.stat().st_mtime, bool(isinstance(d, dict) and d.get("partial"))
    return None


def search_images_ex(ra: float, dec: float) -> dict:
    """Every SPHEREx Level-2 image covering a position: {"frames": [...], "notice": str | None}.

    IRSA's image search has outages (HTTP 502) and slow spells. A list saved less than a day ago is
    used as is. Otherwise IRSA is asked; collections that fail are reported, and if none answers the
    saved list is used whatever its age, so a position that was loaded once keeps working.
    """
    saved = _saved_image_list(ra, dec)
    if saved and not saved[2] and time.time() - saved[1] < 24 * 3600:
        return {"frames": saved[0], "notice": None}
    colls = collections()
    # one query per collection, side by side: IRSA can take 20 s for each
    with ThreadPoolExecutor(max_workers=len(colls)) as ex:
        tables = list(ex.map(lambda c: _sia_rows(c, ra, dec), colls))
    failed = [c for c, t in zip(colls, tables) if isinstance(t, Exception)]
    why = next((str(t) for t in tables if isinstance(t, Exception)), "")
    when = Time(saved[1], format="unix").strftime("%Y-%m-%d") if saved else None
    if len(failed) == len(colls):
        if saved:
            return {"frames": saved[0], "notice": f"IRSA's image search is not answering ({why}). Showing the image list "
                    f"saved on {when}; exposures published since then are missing."}
        raise IOError(f"IRSA's image search is not answering ({why}) and this position has not been loaded here before, "
                      "so there is no saved image list to fall back on. Positions loaded earlier still work. Try again in a few minutes.")
    seen, out = set(), []
    for coll, tab in zip(colls, tables):
        if isinstance(tab, Exception):
            continue
        for row in tab:
            if str(row["dataproduct_subtype"]) != "science":
                continue
            did = str(row["obs_publisher_did"]).split("?")[-1]  # e.g. 2025W19_1B_0116_1/D3
            if did in seen:
                continue
            seen.add(did)
            out.append({
                "id": did,
                "url": str(row["access_url"]),
                "collection": coll,
                "detector": int(str(row["energy_bandpassname"])[-1]),
                "mjd": float(row["t_min"]),
                "exptime": float(row["t_exptime"]),
                "em_min_um": float(row["em_min"]) * 1e6, "em_max_um": float(row["em_max"]) * 1e6,
            })
    notice = None
    if failed:
        # keep what the collections that did not answer contributed last time
        kept = 0
        for f in (saved[0] if saved else []):
            if f["id"] not in seen and f.get("collection") in failed:
                seen.add(f["id"]); out.append(f); kept += 1
        names = ", ".join(c.replace("spherex_", "").upper() for c in failed)
        notice = (f"IRSA did not answer for {names} ({why}). " +
                  (f"Their {kept} exposures come from the list saved on {when}." if kept
                   else "Exposures from those releases are missing; reload in a few minutes to try again."))
    out.sort(key=lambda d: d["mjd"])
    (CACHE / f"sia_{_key(round(ra, 4), round(dec, 4), 'all')}.json").write_text(json.dumps({"frames": out, "partial": bool(failed)}))
    return {"frames": out, "notice": notice}


def search_images(ra: float, dec: float) -> list[dict]:
    return search_images_ex(ra, dec)["frames"]


def group_epochs(frames: list[dict], gap_days: float = 7.0) -> list[dict]:
    """Assign an epoch index to each frame: a new epoch starts after a gap of > gap_days."""
    epochs = []
    for f in frames:
        if not epochs or f["mjd"] - epochs[-1]["mjd_max"] > gap_days:
            epochs.append({"mjd_min": f["mjd"], "mjd_max": f["mjd"], "n": 0})
        e = epochs[-1]
        e["mjd_max"] = f["mjd"]
        e["n"] += 1
        f["epoch"] = len(epochs) - 1
    for e in epochs:
        mid = 0.5 * (e["mjd_min"] + e["mjd_max"])
        e["mjd"] = mid
        e["label"] = Time(mid, format="mjd").strftime("%Y-%m-%d")
        e["decyear"] = float(Time(mid, format="mjd").decimalyear)
    return epochs


# ---------------------------------------------------------------- output grid
def make_grid(ra0: float, dec0: float, npix: int, scale: float = PIXSCALE) -> WCS:
    """North-up, east-left TAN grid. Row 0 of the returned arrays is NORTH (top of the screen)."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra0, dec0]
    w.wcs.crpix = [(npix + 1) / 2, (npix + 1) / 2]
    w.wcs.cdelt = [-scale / 3600, scale / 3600]
    return w


def _bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    h, w = img.shape
    ok = (x0 >= 0) & (y0 >= 0) & (x0 + 1 < w) & (y0 + 1 < h)
    x0c, y0c = np.clip(x0, 0, w - 2), np.clip(y0, 0, h - 2)
    v = (img[y0c, x0c] * (1 - fx) * (1 - fy) + img[y0c, x0c + 1] * fx * (1 - fy)
         + img[y0c + 1, x0c] * (1 - fx) * fy + img[y0c + 1, x0c + 1] * fx * fy)
    v[~ok] = np.nan
    return v


def _load_image(url: str) -> RemoteSpherexImage:
    hk = CACHE / "hdr" / f"{_key(url)}.json"
    if hk.exists():
        return RemoteSpherexImage(url, headers=json.loads(hk.read_text()))
    im = RemoteSpherexImage(url)
    hk.write_text(json.dumps(im.header_cache()))
    return im


def frame_roll(url: str) -> float | None:
    """Detector orientation on the sky (deg), from the cached header. SPHEREx flips ~180 deg between
    passes six months apart, which turns the PSF around; difference images use this to pair like with like."""
    hk = CACHE / "hdr" / f"{_key(url)}.json"
    if not hk.exists():
        return None
    try:
        from astropy.io import fits
        h = fits.Header.fromstring(json.loads(hk.read_text())["img"])
        return float(np.degrees(np.arctan2(h["PC1_2"], h["PC2_2"])))
    except Exception:
        return None


def _frame_cache_path(meta: dict, ra0: float, dec0: float, npix: int) -> Path:
    return CACHE / "frames" / f"{_key(meta['url'], round(ra0, 6), round(dec0, 6), npix, 'v3')}.npz"


def cached_frame(meta: dict, ra0: float, dec0: float, npix: int) -> dict | None:
    """The processed frame if it is already on disk (no network), else None."""
    ck = _frame_cache_path(meta, ra0, dec0, npix)
    if not ck.exists():
        return None
    try:
        z = np.load(ck, allow_pickle=False)
        return {"data": z["data"], **json.loads(str(z["meta"]))}
    except Exception:
        return None  # unreadable cache file: fall back to reading from IRSA


def process_frame(meta: dict, ra0: float, dec0: float, npix: int) -> dict:
    """Reproject one SPHEREx exposure onto the common grid. Cached on disk."""
    ck = _frame_cache_path(meta, ra0, dec0, npix)
    hit = cached_frame(meta, ra0, dec0, npix)
    if hit is not None:
        return hit

    im = _load_image(meta["url"])
    grid = make_grid(ra0, dec0, npix)
    jj, ii = np.mgrid[0:npix, 0:npix]
    # array row 0 = north => FITS y index = npix-1-row
    wra, wdec = grid.wcs_pix2world(ii.ravel(), (npix - 1 - jj).ravel(), 0)
    sx, sy = im.wcs.all_world2pix(wra, wdec, 0)
    cx, cy = im.wcs.all_world2pix([ra0], [dec0], 0)
    margin = 3
    x0, x1 = int(np.floor(np.nanmin(sx))) - margin, int(np.ceil(np.nanmax(sx))) + margin + 1
    y0, y1 = int(np.floor(np.nanmin(sy))) - margin, int(np.ceil(np.nanmax(sy))) + margin + 1
    win = im.window(x0, x1, y0, y1)
    hdr = im.img_hdr
    out_meta = {
        "mjd_avg": float(hdr.get("MJD-AVG", meta["mjd"])),
        "date": str(hdr.get("DATE-AVG", ""))[:19],
        "x": float(cx[0]), "y": float(cy[0]),
    }
    if win is None:
        data = np.full((npix, npix), np.nan, np.float32)
        out_meta.update(coverage=0.0, wavelength=None, bandwidth=None, flags_near=[], bg=None)
    else:
        img, flg, (ox, oy) = win
        img = img.copy()
        img[(flg & HARD_BAD) != 0] = np.nan
        data = _bilinear(img, sx - ox, sy - oy).reshape(npix, npix).astype(np.float32)
        bg = float(np.nanmedian(data)) if np.isfinite(data).any() else None
        if bg is not None:
            data -= bg  # remove zodiacal light / smooth background
        # contamination flags within ~2 native px of target position
        tx, ty = int(round(cx[0])) - ox, int(round(cy[0])) - oy
        near = flg[max(0, ty - 2):ty + 3, max(0, tx - 2):tx + 3]
        bits = int(np.bitwise_or.reduce(near.ravel())) if near.size else 0
        flags_near = [n for b, n in REPORT_FLAGS.items() if bits & b]
        try:
            sw = im.wavelength_wcs()
            wl, bw = sw.pixel_to_world(cx[0], cy[0])
            wl, bw = float(wl.to(u.um).value), float(bw.to(u.um).value)
        except Exception:
            wl = bw = None
        out_meta.update(coverage=float(np.isfinite(data).mean()), wavelength=wl, bandwidth=bw,
                        flags_near=flags_near, bg=bg)
    # MJy/sr per pixel -> mJy per output pixel
    out_meta["mjy_per_unit"] = float((PIXSCALE / 206264.806) ** 2 * 1e6 * 1e3)
    np.savez_compressed(ck, data=data, meta=json.dumps(out_meta))
    return {"data": data, **out_meta}


def encode_f32(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode()


# ---------------------------------------------------------------- Gaia DR3 overlay
# The same Gaia DR3 table from two archives: STScI/MAST (the one the challenge lists) and ESA's own.
GAIA_TAP = [
    ("https://mast.stsci.edu/vo-tap/api/v0.1/gaiadr3/sync", "dbo.gaia_source"),
    ("https://gea.esac.esa.int/tap-server/tap/sync", "gaiadr3.gaia_source"),
]


def gaia_sources(ra: float, dec: float, radius_deg: float, gmax: float = 19.0) -> list[dict]:
    ck = CACHE / f"gaia_{_key(round(ra, 4), round(dec, 4), round(radius_deg, 4), gmax, 'v2')}.json"
    if ck.exists():
        return json.loads(ck.read_text())
    lines, last = None, None
    for url, table in GAIA_TAP:
        q = f"""SELECT TOP 3000 source_id, ra, dec, pmra, pmdec, parallax, parallax_error, phot_g_mean_mag,
       bp_rp, teff_gspphot, radial_velocity, phot_variable_flag
FROM {table}
WHERE 1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg}))
  AND phot_g_mean_mag < {gmax}
ORDER BY phot_g_mean_mag"""
        try:
            r = requests.get(url, params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": q},
                             timeout=(8, 60), headers=UA)  # give up quickly on a host that is down
            if r.ok and r.text.lstrip().startswith("source_id"):
                lines = r.text.strip().splitlines()
                break
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = type(e).__name__
    if lines is None:
        raise IOError(f"no Gaia DR3 archive is answering ({last})")
    cols = [c.strip() for c in lines[0].split(",")]
    out = []
    for ln in lines[1:]:
        v = {c: x.strip() for c, x in zip(cols, ln.split(","))}
        f = lambda k: float(v[k]) if v.get(k) not in (None, "", "null", "NaN") else None
        out.append({"id": v["source_id"], "ra": f("ra"), "dec": f("dec"), "pmra": f("pmra") or 0.0,
                    "pmdec": f("pmdec") or 0.0, "plx": f("parallax"), "plx_err": f("parallax_error"),
                    "g": f("phot_g_mean_mag"), "bp_rp": f("bp_rp"), "teff": f("teff_gspphot"),
                    "rv": f("radial_velocity"), "variable": v.get("phot_variable_flag", "").strip('"') == "VARIABLE"})
    ck.write_text(json.dumps(out))
    return out


# ---------------------------------------------------------------- WISE sources (CatWISE2020, IRSA)
GATOR_URL = "https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query"


def wise_sources(ra: float, dec: float, radius_deg: float) -> list[dict]:
    """CatWISE2020 sources around a position: W1 (3.4 um) and W2 (4.6 um) magnitudes and proper motion.

    CatWISE is the WISE catalogue with motions, so its sources can be placed at each frame's date like
    Gaia's. A red W1-W2 colour with no Gaia counterpart is what a cold brown dwarf looks like.
    """
    ck = CACHE / f"wise_{_key(round(ra, 4), round(dec, 4), round(radius_deg, 4))}.json"
    if ck.exists():
        return json.loads(ck.read_text())
    r = requests.get(GATOR_URL, timeout=(10, 90), headers=UA, params={
        "catalog": "catwise_2020", "spatial": "cone", "radius": round(min(radius_deg, 0.3) * 3600), "radunits": "arcsec",
        "objstr": f"{ra} {dec}", "outfmt": 1, "selcols": "source_name,ra,dec,w1mpro,w2mpro,pmra,pmdec,meanobsmjd"})
    r.raise_for_status()
    lines = r.text.splitlines()
    head = next((ln for ln in lines if ln.startswith("|")), None)
    if head is None:
        raise IOError("unexpected answer from IRSA's catalogue service")
    cuts = [i for i, ch in enumerate(head) if ch == "|"]
    cols = [c.strip() for c in head.strip("|").split("|")]
    out = []
    for ln in lines:
        if not ln or ln[0] in "\\|":
            continue
        v = {c: ln[a + 1:b + 1].strip() for c, (a, b) in zip(cols, zip(cuts[:-1], cuts[1:]))}
        f = lambda k: float(v[k]) if v.get(k) not in (None, "", "null") else None
        if f("ra") is None or f("dec") is None:
            continue
        mjd = f("meanobsmjd")
        out.append({"id": v.get("source_name"), "ra": f("ra"), "dec": f("dec"), "w1": f("w1mpro"), "w2": f("w2mpro"),
                    "pmra": (f("pmra") or 0.0) * 1000, "pmdec": (f("pmdec") or 0.0) * 1000,  # arcsec/yr -> mas/yr
                    "epoch": 2000.0 + (mjd - 51544.5) / 365.25 if mjd else 2015.4})
    ck.write_text(json.dumps(out))
    return out


# ---------------------------------------------------------------- SIMBAD: names and object types
# SIMBAD is run by CDS; Harvard hosts its official mirror, which is tried first because CDS can be down.
SIMBAD_TAP = ["https://simbad.cfa.harvard.edu/simbad/sim-tap/sync", "https://simbad.cds.unistra.fr/simbad/sim-tap/sync"]


def simbad_objects(ra: float, dec: float, radius_deg: float) -> list[dict]:
    """Known objects in the field: name, type in words, spectral type, proper motion (positions at
    J2000) and the Gaia DR3 id when SIMBAD has one, which is how they are matched to the Gaia overlay."""
    ck = CACHE / f"simbad_{_key(round(ra, 4), round(dec, 4), round(radius_deg, 4))}.json"
    if ck.exists():
        return json.loads(ck.read_text())
    q = (
        "SELECT TOP 400 b.main_id, b.ra, b.dec, b.pmra, b.pmdec, b.plx_value, b.sp_type, b.otype, o.description, i.id AS gaia "
        "FROM basic AS b JOIN otypedef AS o ON o.otype = b.otype "
        "LEFT JOIN ident AS i ON i.oidref = b.oid AND i.id LIKE 'Gaia DR3 %' "
        f"WHERE CONTAINS(POINT('ICRS', b.ra, b.dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg})) = 1"
    )
    last = None
    for url in SIMBAD_TAP:
        try:
            r = requests.get(url, params={"request": "doQuery", "lang": "adql", "format": "tsv", "query": q},
                             timeout=40, headers=UA)
            if r.ok and r.text.startswith("main_id"):
                break
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = str(e)
    else:
        raise IOError(f"SIMBAD is not answering ({last})")
    lines = r.text.strip().splitlines()
    cols = lines[0].split("\t")
    out = []
    for ln in lines[1:]:
        v = {c: x.strip().strip('"').strip() for c, x in zip(cols, ln.split("\t"))}
        f = lambda k: float(v[k]) if v.get(k) else None
        if f("ra") is None or f("dec") is None:
            continue
        out.append({"name": re.sub(r"\s+", " ", v["main_id"]), "ra": f("ra"), "dec": f("dec"),
                    "pmra": f("pmra") or 0.0, "pmdec": f("pmdec") or 0.0, "plx": f("plx_value"),
                    "sptype": v.get("sp_type") or None, "otype": v.get("otype") or None,
                    "kind": v.get("description") or None,
                    "gaia": (v.get("gaia") or "").replace("Gaia DR3 ", "") or None})
    ck.write_text(json.dumps(out))
    return out


# ---------------------------------------------------------------- solar-system objects (IRSA MOST)
MOST_URL = "https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most"
SURVEY_START = "2025-04-01"  # just before SPHEREx began its survey


def _most_query(params: dict) -> requests.Response:
    last = None
    for attempt in range(3):
        try:
            r = requests.get(MOST_URL, params={"catalog": "spherex", "output_mode": "Brief",
                                               "obs_begin": SURVEY_START,
                                               "obs_end": Time.now().strftime("%Y-%m-%d"), **params},
                             timeout=240, headers=UA)
            if r.status_code < 500:
                return r
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = str(e)
        time.sleep(2 * (attempt + 1))
    raise IOError(f"IRSA MOST is not answering ({last}); try again shortly")


def most_search(name: str) -> dict:
    """Every SPHEREx exposure that caught a solar-system object, with its predicted position in each.

    Uses IRSA's Moving Object Search Tool, which propagates the JPL Horizons orbit to each exposure time.
    `name` is an asteroid/comet name or designation ("Vesta", "433 Eros", "3I/ATLAS") or a NAIF id.
    Returns {"object": resolved name, "orbit": {...}, "frames": [...]} with frames sorted by time.
    """
    name = name.strip()
    ck = CACHE / f"most_{_key(name.lower())}.json"
    if ck.exists() and time.time() - ck.stat().st_mtime < 7 * 86400:  # MOST takes about a minute per object
        return json.loads(ck.read_text())
    if re.fullmatch(r"\d{3,}", name):
        r = _most_query({"input_type": "naifid_input", "obj_naifid": name})
    else:
        # MOST wants the bare Horizons name: "Eros" not "433 Eros", "3I" or "C/2025 N1" not "3I/ATLAS".
        variants = [name]
        if m := re.fullmatch(r"\(?\d+\)?\s+(.+)", name):
            variants.append(m.group(1))
        if m := re.fullmatch(r"(\d+[IP])/.+", name, re.I):
            variants.append(m.group(1))
        for v in variants:
            r = _most_query({"input_type": "name_input", "obj_name": v})
            if "|" in r.text or "NAIF ID=" in r.text:
                break
        cands = re.findall(r"^\s*(.+?), Object Type=([^,]+), NAIF ID=(\d+), Designation=(\S.*?)\s*$", r.text, re.M)
        if "|" not in r.text and cands:
            real = [c for c in cands if c[3] != "NO_VALUE"]
            if len(real) == 1 or len(cands) == 1:
                # e.g. "Ceres" matches two Horizons records, only one with a designation
                r = _most_query({"input_type": "naifid_input", "obj_naifid": (real or cands)[0][2]})
            else:
                opts = "; ".join(f"{c[0]} [{c[1]}] = {c[2]}" for c in cands[:8])
                raise ValueError(f"'{name}' matches several objects. Search again with the NAIF id of the one you want: {opts}")
    lines = r.text.splitlines()
    head = next((ln for ln in lines if ln.startswith("|")), None)
    if head is None:
        msg = " ".join(re.sub(r"<[^>]+>", " ", r.text).split())[:300]
        raise ValueError(f"MOST could not find '{name}': {msg or 'no answer'}")
    info = dict(re.findall(r'^[\\](\w+)\s*=\s*"?\s*([^"\n]*?)\s*"?\s*$', r.text, re.M))
    cuts = [i for i, ch in enumerate(head) if ch == "|"]
    cols = [c.strip() for c in head.strip("|").split("|")]
    seen, frames = set(), []
    rows = [ln for ln in lines if ln and ln[0] == " " and ".fits" in ln]
    # prefer the Data Release over Quick Release when the same exposure is in both
    rows.sort(key=lambda ln: "/dr" not in ln)
    for ln in rows:
        v = {c: ln[a + 1:b + 1].strip() for c, (a, b) in zip(cols, zip(cuts[:-1], cuts[1:]))}
        try:
            fid = f"{v['observationid']}/{v['productid']}"
            if fid in seen:
                continue
            seen.add(fid)
            uri = v["uri"]
            frames.append({
                "id": fid, "url": "https://irsa.ipac.caltech.edu/" + uri.lstrip("/"),
                "collection": "spherex_" + uri.split("/")[3] if uri.count("/") > 3 else "spherex",
                "detector": int(v["productid"][-1]),
                "mjd": float(v["mjd_start"]), "exptime": float(v["exposure_time"]),
                "ra_obj": float(v["ra_obj"]), "dec_obj": float(v["dec_obj"]),
                "vmag": float(v["vmag"]), "sun_dist": float(v["sun_dist"]), "geo_dist": float(v["geo_dist"]),
                "phase": float(v["phase"]),
            })
        except (KeyError, ValueError):
            continue  # malformed row
    frames.sort(key=lambda f: f["mjd"])
    out = {"object": info.get("object_name", name),
           "orbit": {k: info[k] for k in ("semimajor_axis", "eccentricity", "inclination") if k in info},
           "frames": frames}
    ck.write_text(json.dumps(out))
    return out
