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
# Newest releases first; each collection is queried and results merged (dedup by obs id + detector).
# Add new releases here as IRSA publishes them (e.g. "spherex_qr4").
COLLECTIONS = [c.strip() for c in os.environ.get("SPHEREX_COLLECTIONS", "spherex_dr1,spherex_qr3").split(",") if c.strip()]
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
def search_images(ra: float, dec: float) -> list[dict]:
    ck = CACHE / f"sia_{_key(round(ra, 4), round(dec, 4), *COLLECTIONS)}.json"
    if ck.exists() and time.time() - ck.stat().st_mtime < 6 * 3600:
        return json.loads(ck.read_text())
    seen, out = set(), []
    for coll in COLLECTIONS:
        last = None
        for attempt in range(4):
            r = requests.get(SIA_URL, params={"COLLECTION": coll, "POS": f"circle {ra} {dec} 0.0005"},
                             timeout=180, headers=UA)
            if r.ok and r.content.lstrip().startswith(b"<?xml"):
                break
            last = r.status_code
            time.sleep(1.5 * (attempt + 1))
        else:
            raise IOError(f"IRSA SIA query failed for {coll} (HTTP {last}); IRSA may be busy, retry shortly")
        tab = parse_single_table(io.BytesIO(r.content)).to_table(use_names_over_ids=True)
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
    out.sort(key=lambda d: d["mjd"])
    ck.write_text(json.dumps(out))
    return out


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


def process_frame(meta: dict, ra0: float, dec0: float, npix: int) -> dict:
    """Reproject one SPHEREx exposure onto the common grid. Cached on disk."""
    ck = CACHE / "frames" / f"{_key(meta['url'], round(ra0, 6), round(dec0, 6), npix, 'v3')}.npz"
    if ck.exists():
        z = np.load(ck, allow_pickle=False)
        return {"data": z["data"], **json.loads(str(z["meta"]))}

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
def gaia_sources(ra: float, dec: float, radius_deg: float, gmax: float = 19.0) -> list[dict]:
    ck = CACHE / f"gaia_{_key(round(ra, 4), round(dec, 4), round(radius_deg, 4), gmax)}.json"
    if ck.exists():
        return json.loads(ck.read_text())
    q = f"""SELECT TOP 3000 source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag
FROM gaiadr3.gaia_source
WHERE 1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg}))
  AND phot_g_mean_mag < {gmax}
ORDER BY phot_g_mean_mag"""
    r = requests.post("https://gea.esac.esa.int/tap-server/tap/sync",
                      data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": q},
                      timeout=90, headers=UA)
    r.raise_for_status()
    lines = r.text.strip().splitlines()
    cols = lines[0].split(",")
    out = []
    for ln in lines[1:]:
        v = dict(zip(cols, ln.split(",")))
        f = lambda k: float(v[k]) if v.get(k) not in (None, "", "null") else None
        out.append({"id": v["source_id"], "ra": f("ra"), "dec": f("dec"), "pmra": f("pmra") or 0.0,
                    "pmdec": f("pmdec") or 0.0, "plx": f("parallax"), "g": f("phot_g_mean_mag")})
    ck.write_text(json.dumps(out))
    return out
