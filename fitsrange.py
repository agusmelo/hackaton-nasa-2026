"""Read small pixel windows out of remote SPHEREx L2 FITS files with HTTP range requests.

A full SPHEREx Level-2 MEF is ~65 MB (IMAGE, FLAGS, VARIANCE, ZODI as 2040x2040
arrays plus an ePSF table). IRSA's cutout service works, but every cutout carries
the full ePSF table (~4 MB) and takes ~10 s. Reading only the header blocks and the
pixel rows we need is ~20x less data and several times faster.

Layout verified against DR1 files (l2b-v27):
  HDU0 primary (no data) | HDU1 IMAGE float32 (uncompressed) |
  HDU2 FLAGS int32, RICE_1 tile-compressed, one tile per row | ... | HDU6 WCS-WAVE table
"""
from __future__ import annotations

import io
import os
import random
import threading
import time
import warnings
import logging

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

warnings.filterwarnings("ignore", category=FITSFixedWarning)
warnings.filterwarnings("ignore", module="astropy.wcs")
logging.getLogger("astropy").setLevel(logging.ERROR)

BLOCK = 2880
_local = threading.local()


def _session() -> requests.Session:
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = "spherex-motion-viewer/0.1 (prototype)"
        _local.s = s
    return s


IRSA_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
AWS_PREFIX = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
# "aws" (default): read from NASA's public S3 mirror first, fall back to IRSA. "irsa": IRSA only.
SOURCE = os.environ.get("SPHEREX_SOURCE", "aws").lower()
_aws_misses = 0  # consecutive S3 failures; after a few, stop trying it for this process


def _get(url: str, rng: str) -> bytes:
    """Range read. `url` is always the IRSA URL (it is also the cache key); the same object
    is fetched from the S3 mirror when possible, which is about twice as fast and is not throttled."""
    global _aws_misses
    if SOURCE == "aws" and _aws_misses < 8 and url.startswith(IRSA_PREFIX):
        try:
            r = _session().get(AWS_PREFIX + url[len(IRSA_PREFIX):], headers={"Range": f"bytes={rng}"}, timeout=30)
            if r.status_code == 206:
                _aws_misses = 0
                return r.content
        except requests.RequestException:
            pass
        _aws_misses += 1  # not mirrored yet, or S3 unreachable: use IRSA for this read
    last = ""
    for attempt in range(6):
        try:
            r = _session().get(url, headers={"Range": f"bytes={rng}"}, timeout=60)
            if r.status_code == 206:
                return r.content
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:  # transient network trouble
            last = str(e)
        # IRSA answers 502/503/429 when busy: back off with jitter
        time.sleep(min(20.0, 0.8 * 2 ** attempt) * (0.5 + random.random()))
    raise IOError(f"range read failed ({last}) for {url}")


def _get_range(url: str, start: int, end: int) -> bytes:
    """Inclusive byte range."""
    return _get(url, f"{start}-{end}")


def _parse_header(buf: bytes, pos: int):
    """Parse a header starting at buf[pos]; return (header, header_len) or None if END not in buf."""
    for i in range(pos, len(buf) - 79, 80):
        if buf[i:i + 8] == b"END     ":
            hlen = ((i + 80 - pos + BLOCK - 1) // BLOCK) * BLOCK
            return fits.Header.fromstring(buf[pos:i + 80].decode("ascii")), hlen
    return None


def _read_header(url: str, offset: int, chunk: int = 8 * BLOCK):
    buf = b""
    while len(buf) < 60 * BLOCK:
        buf += _get_range(url, offset + len(buf), offset + len(buf) + chunk - 1)
        got = _parse_header(buf, 0)
        if got:
            return got[0], offset + got[1]
    raise IOError("FITS header END not found")


def _hdu_data_size(h: fits.Header) -> int:
    if h.get("NAXIS", 0) == 0:
        return 0
    n = abs(h["BITPIX"]) // 8
    for k in range(1, h["NAXIS"] + 1):
        n *= h[f"NAXIS{k}"]
    n += h.get("PCOUNT", 0)
    return ((n + BLOCK - 1) // BLOCK) * BLOCK


_DT = {-32: ">f4", -64: ">f8", 32: ">i4", 16: ">i2", 8: "u1"}


def _read_rows(url: str, h: fits.Header, data_off: int, y0: int, y1: int) -> np.ndarray:
    """Rows y0..y1-1 (0-based) of an uncompressed 2-D image HDU."""
    nx = h["NAXIS1"]
    bpp = abs(h["BITPIX"]) // 8
    raw = _get_range(url, data_off + y0 * nx * bpp, data_off + y1 * nx * bpp - 1)
    arr = np.frombuffer(raw, dtype=_DT[h["BITPIX"]]).reshape(y1 - y0, nx)
    return arr.astype(np.float32 if h["BITPIX"] < 0 else np.int32)


def _read_rows_compressed(url: str, h: fits.Header, data_off: int, y0: int, y1: int) -> np.ndarray:
    """Rows of a RICE_1 tile-compressed image whose tiles are single rows (ZTILE2 == 1)."""
    from astropy.io.fits.hdu.compressed._codecs import Rice1

    if h.get("ZCMPTYPE") != "RICE_1" or h.get("ZTILE2", 1) != 1 or h["ZTILE1"] != h["ZNAXIS1"] or h["NAXIS1"] != 8:
        raise NotImplementedError("only row-tiled RICE_1 with 1P descriptors supported")
    desc = np.frombuffer(_get_range(url, data_off + y0 * 8, data_off + y1 * 8 - 1), dtype=">i4").reshape(-1, 2)
    heap = data_off + h.get("THEAP", h["NAXIS1"] * h["NAXIS2"])
    lo, hi = int(desc[:, 1].min()), int((desc[:, 1] + desc[:, 0]).max())
    blob = _get_range(url, heap + lo, heap + hi - 1)
    nx = h["ZNAXIS1"]
    opts = {h.get(f"ZNAME{i}"): h.get(f"ZVAL{i}") for i in range(1, 5)}
    codec = Rice1(blocksize=opts.get("BLOCKSIZE", 32), bytepix=opts.get("BYTEPIX", 4), tilesize=nx)
    out = np.empty((y1 - y0, nx), dtype=np.int32)
    for i, (n, o) in enumerate(desc):
        out[i] = codec.decode(np.frombuffer(blob[o - lo:o - lo + n], dtype=np.uint8))
    return out


class RemoteSpherexImage:
    """Remote SPHEREx L2 spectral image; only headers are read on construction."""

    def __init__(self, url: str, headers: dict | None = None):
        self.url = url
        if headers:  # from disk cache
            self.img_hdr = fits.Header.fromstring(headers["img"])
            self.flag_hdr = fits.Header.fromstring(headers["flag"])
            self.img_off, self.flag_off = headers["img_off"], headers["flag_off"]
        else:
            buf = _get_range(url, 0, 12 * BLOCK - 1)  # primary + IMAGE header in one request
            prim, plen = _parse_header(buf, 0)
            img_pos = plen + _hdu_data_size(prim)
            got = _parse_header(buf, img_pos)
            if got:
                self.img_hdr, ilen = got
                self.img_off = img_pos + ilen
            else:
                self.img_hdr, self.img_off = _read_header(url, img_pos)
            self.flag_hdr, self.flag_off = _read_header(url, self.img_off + _hdu_data_size(self.img_hdr))
        self.wcs = WCS(self.img_hdr)

    def header_cache(self) -> dict:
        return {"img": self.img_hdr.tostring(), "flag": self.flag_hdr.tostring(),
                "img_off": self.img_off, "flag_off": self.flag_off}

    def flag_names(self) -> dict[int, str]:
        return {int(self.flag_hdr[k]): self.flag_hdr[k.replace("MSKM", "MSKN")]
                for k in self.flag_hdr if k.startswith("MSKM")}

    def window(self, x0: int, x1: int, y0: int, y1: int):
        """(image, flags, (x0, y0)) for pixel box [x0,x1) x [y0,y1), clipped to the detector."""
        nx, ny = self.img_hdr["NAXIS1"], self.img_hdr["NAXIS2"]
        x0c, x1c, y0c, y1c = max(0, x0), min(nx, x1), max(0, y0), min(ny, y1)
        if x0c >= x1c or y0c >= y1c:
            return None
        img = _read_rows(self.url, self.img_hdr, self.img_off, y0c, y1c)[:, x0c:x1c]
        if self.flag_hdr.get("ZIMAGE"):
            flg = _read_rows_compressed(self.url, self.flag_hdr, self.flag_off, y0c, y1c)[:, x0c:x1c]
        else:
            flg = _read_rows(self.url, self.flag_hdr, self.flag_off, y0c, y1c)[:, x0c:x1c]
        return img, flg, (x0c, y0c)

    def wavelength_wcs(self):
        """Spectral WCS (key 'W', WAVE-TAB lookup) from the small WCS-WAVE table at the end of the file."""
        tail = _get(self.url, f"-{6 * BLOCK}")  # suffix range: last 6 blocks
        idx = None
        for i in range(len(tail) % BLOCK, len(tail), BLOCK):
            blk = tail[i:i + BLOCK]
            if blk.startswith(b"XTENSION= 'BINTABLE'") and b"WCS-WAVE" in blk:
                idx = i
        if idx is None:
            raise IOError("WCS-WAVE extension not found in file tail")
        mini = fits.PrimaryHDU().header.tostring().encode("ascii")
        hl = fits.open(io.BytesIO(mini + tail[idx:]))
        hl.append(fits.ImageHDU(header=self.img_hdr.copy(), name="IMAGE"))
        sw = WCS(self.img_hdr, fobj=hl, key="W")
        sw.sip = None
        return sw
