"""Pre-fetch the challenge test targets so the demo loads instantly.

Usage: python warm_cache.py [fov_arcmin]
"""
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

import spherex as sx

TARGETS = ["Barnard's star", "eps Ind B", "WISE J085510.83-071442.5", "RW Aur", "R Dra"]

fov = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0
npix = int(round(fov * 60 / sx.PIXSCALE)) | 1
for name in TARGETS:
    t = time.time()
    r = sx.resolve(name)
    ra, dec = sx.propagate(r["ra"], r["dec"], r["pmra"], r["pmdec"], 2000.0, 2026.0)
    metas = sx.search_images(ra, dec)
    with ThreadPoolExecutor(8) as ex:
        frames = list(ex.map(lambda m: sx.process_frame(m, ra, dec, npix), metas))
    flags = sum(1 for f in frames if f["flags_near"])
    ep = sx.group_epochs(metas)
    print(f"{name:28s} {len(metas):4d} frames  {len(ep)} epochs  {flags} with flags near target  "
          f"{time.time() - t:6.1f}s", flush=True)
    try:
        sx.gaia_sources(ra, dec, fov / 60 * 0.75 + 0.01)
    except Exception as e:
        print("  gaia failed:", e)
