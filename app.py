"""SPHEREx Motion Viewer: FastAPI backend.

Run:  python -m uvicorn app:app --port 8765
Then open http://localhost:8765/?target=WISE%200855
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from astropy.time import Time
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import spherex as sx

app = FastAPI(title="SPHEREx Motion Viewer")
POOL = ThreadPoolExecutor(max_workers=10)  # be gentle with IRSA; it answers 503 under heavy parallel load
JOBS: dict[str, dict] = {}
STATIC = Path(__file__).parent / "static"
MAX_FOV_ARCMIN = 15.0


@app.get("/api/resolve")
def api_resolve(q: str):
    c = sx.parse_coords(q)
    if c:
        return {"name": None, "ra": c[0], "dec": c[1], "pmra": 0.0, "pmdec": 0.0, "epoch": None}
    try:
        return sx.resolve(q)
    except Exception as e:
        raise HTTPException(404, str(e))


def _gaia_result(fut) -> list:
    try:
        return fut.result()
    except Exception:
        return []  # overlay is optional; the viewer works without it


def _run_job(job: dict, ra: float, dec: float, fov: float, pmra: float, pmdec: float, epoch: float | None):
    try:
        t0 = time.time()
        # Centre the grid where the target is during the SPHEREx survey (matters for Barnard's Star: ~4' since J2000)
        ref_epoch = 2026.0
        if epoch is not None and (pmra or pmdec):
            ra_c, dec_c = sx.propagate(ra, dec, pmra, pmdec, epoch, ref_epoch)
        else:
            ra_c, dec_c = ra, dec
        job["stage"] = "Searching IRSA for SPHEREx images"
        metas = sx.search_images(ra_c, dec_c)
        if not metas:
            raise ValueError("No SPHEREx images cover this position yet")
        epochs = sx.group_epochs(metas)
        npix = int(round(fov * 60 / sx.PIXSCALE)) | 1  # odd => target on a pixel centre
        # Everything the client needs to start drawing; frames then stream in as they are read.
        job["meta"] = {
            "center": {"ra": ra_c, "dec": dec_c, "epoch": ref_epoch},
            "input": {"ra": ra, "dec": dec, "pmra": pmra, "pmdec": pmdec, "epoch": epoch},
            "npix": npix, "scale": sx.PIXSCALE, "fov_arcmin": fov,
            "epochs": epochs, "collections": sx.COLLECTIONS, "total": len(metas),
        }
        job.update(stage="Reading SPHEREx exposures", total=len(metas), done=0)
        gaia_fut = POOL.submit(sx.gaia_sources, ra_c, dec_c, fov / 60 * 0.75 + 0.01)
        futs = {POOL.submit(sx.process_frame, m, ra_c, dec_c, npix): m for m in metas}
        for f in as_completed(futs):
            m = futs[f]
            try:
                fr = f.result()
                d = fr.pop("data")
                if fr.get("coverage", 0) >= 0.05:
                    job["ready"].append({**m, **fr, "roll": sx.frame_roll(m["url"]), "data": sx.encode_f32(d)})
            except Exception as e:  # keep going; count per-frame failures
                job["failed"] += 1
                job["last_error"] = str(e)
            job["done"] += 1
            if job["gaia"] is None and gaia_fut.done():
                job["gaia"] = _gaia_result(gaia_fut)
        job["stage"] = "Querying Gaia DR3"
        if job["gaia"] is None:
            job["gaia"] = _gaia_result(gaia_fut)
        job["elapsed_s"] = round(time.time() - t0, 1)
        job["status"] = "done"
    except Exception as e:
        traceback.print_exc()
        job.update(status="error", error=str(e))


@app.post("/api/jobs")
def api_job(ra: float, dec: float, fov: float = Query(5.0, gt=0.5, le=MAX_FOV_ARCMIN),
            pmra: float = 0.0, pmdec: float = 0.0, epoch: float | None = None):
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "status": "running", "stage": "Queued", "done": 0, "total": 0, "created": time.time(),
           "ready": [], "failed": 0, "gaia": None, "meta": None}
    JOBS[jid] = job
    threading.Thread(target=_run_job, args=(job, ra, dec, fov, pmra, pmdec, epoch), daemon=True).start()
    # forget old jobs
    for k in [k for k, v in JOBS.items() if time.time() - v["created"] > 3600]:
        JOBS.pop(k, None)
    return {"id": jid}


@app.get("/api/jobs/{jid}")
def api_job_status(jid: str, since: int = 0, gaia: int = 1):
    """Progress plus the frames finished since index `since` (the client passes back `next`)."""
    job = JOBS.get(jid)
    if not job:
        raise HTTPException(404, "unknown job")
    status = job["status"]  # read before the frame count so a "done" reply always carries the last frames
    n = len(job["ready"])
    out = {k: job.get(k) for k in ("id", "stage", "done", "total", "failed", "error", "last_error", "elapsed_s")}
    out.update(status=status, frames=job["ready"][since:n], next=n)
    if since == 0:
        out["meta"] = job["meta"]
    if gaia and job["gaia"] is not None:
        out["gaia"] = job["gaia"]
    return out


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
