"""SPHEREx Motion Viewer: FastAPI backend.

Run:  python -m uvicorn app:app --port 8765
Then open http://localhost:8765/?target=WISE%200855
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

from astropy.time import Time
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import spherex as sx
from fitsrange import SOURCE

app = FastAPI(title="SPHEREx Motion Viewer")
# NASA's S3 mirror takes many parallel range reads (measured 6.9 frames/s with 24 readers);
# IRSA answers 503 under heavy parallel load, so stay gentle when reading from it directly.
POOL = ThreadPoolExecutor(max_workers=24 if SOURCE == "aws" else 10)
AUX = ThreadPoolExecutor(max_workers=2)  # Gaia lookups: never queued behind SPHEREx reads
JOBS: dict[str, dict] = {}
STATIC = Path(__file__).parent / "static"
MAX_FOV_ARCMIN = 15.0
REF_EPOCH = 2026.0  # fixed targets are centred where they are at this epoch
ABANDON_AFTER_S = 75  # a search whose page stopped polling is cancelled after this long (hidden tabs poll as rarely as once a minute)


@app.middleware("http")
async def revalidate_frontend(request, call_next):
    """Make browsers revalidate the page and its own JS/CSS on every load, so an updated
    frontend is never hidden behind a stale cached copy. The large vendored libraries may be cached."""
    resp = await call_next(request)
    path = request.url.path
    if path == "/" or (path.startswith("/static/") and not path.startswith("/static/vendor/")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


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


def _deliver(job: dict, m: dict, fr: dict) -> None:
    """Hand one processed frame to the client queue."""
    d = fr.pop("data")
    if fr.get("coverage", 0) >= 0.05:
        job["ready"].append({**m, **fr, "roll": sx.frame_roll(m["url"]), "data": sx.encode_f32(d)})
    job["done"] += 1


def _run_job(job: dict, ra: float | None, dec: float | None, fov: float, pmra: float, pmdec: float,
             epoch: float | None, moving: str | None):
    try:
        t0 = time.time()
        npix = int(round(fov * 60 / sx.PIXSCALE)) | 1  # odd => target on a pixel centre
        if moving:
            # Solar-system object: IRSA's Moving Object Search Tool gives every SPHEREx exposure that
            # caught it, with its predicted position. Each frame is centred on that position, so the
            # object stays put while the background stars move.
            job["stage"] = f"Asking IRSA MOST where {moving} was when SPHEREx looked"
            found = sx.most_search(moving)
            metas = found["frames"]
            if not metas:
                raise ValueError(f"SPHEREx has not imaged {found['object']} yet")
            centre_of = lambda m: (m["ra_obj"], m["dec_obj"])
            ra_c, dec_c = centre_of(metas[len(metas) // 2])
            extra = {"moving": True, "object": found["object"], "orbit": found["orbit"]}
            gaia_fut = None
            job["gaia"] = []  # background stars differ in every frame: no overlay in this mode
        else:
            # Centre the grid where the target is during the SPHEREx survey (matters for Barnard's Star: ~4' since J2000)
            if epoch is not None and (pmra or pmdec):
                ra_c, dec_c = sx.propagate(ra, dec, pmra, pmdec, epoch, REF_EPOCH)
            else:
                ra_c, dec_c = ra, dec
            job["stage"] = "Searching IRSA for SPHEREx images"
            metas = sx.search_images(ra_c, dec_c)
            if not metas:
                raise ValueError("No SPHEREx images cover this position yet")
            centre_of = lambda m: (ra_c, dec_c)
            extra = {"moving": False}
            gaia_fut = AUX.submit(sx.gaia_sources, ra_c, dec_c, fov / 60 * 0.75 + 0.01)
        epochs = sx.group_epochs(metas)
        # Everything the client needs to start drawing; frames then stream in as they are read.
        job["meta"] = {
            "center": {"ra": ra_c, "dec": dec_c, "epoch": REF_EPOCH},
            "input": {"ra": ra, "dec": dec, "pmra": pmra, "pmdec": pmdec, "epoch": epoch},
            "npix": npix, "scale": sx.PIXSCALE, "fov_arcmin": fov,
            "epochs": epochs, "collections": sx.COLLECTIONS, "total": len(metas), **extra,
        }
        job.update(stage="Reading SPHEREx exposures", total=len(metas), done=0)
        # Frames already on disk are delivered straight away, without queueing behind another
        # job's network reads in the shared pool. Only the rest go to the pool.
        pending = []
        for m in metas:
            fr = sx.cached_frame(m, *centre_of(m), npix)
            if fr is None:
                pending.append(m)
            else:
                _deliver(job, m, fr)
        futs = {POOL.submit(sx.process_frame, m, *centre_of(m), npix): m for m in pending}
        todo = set(futs)
        while todo:
            finished, todo = wait(todo, timeout=2, return_when=FIRST_COMPLETED)
            for f in finished:
                try:
                    _deliver(job, futs[f], f.result())
                except Exception as e:  # keep going; count per-frame failures
                    job["failed"] += 1
                    job["last_error"] = str(e)
                    job["done"] += 1
            if job["gaia"] is None and gaia_fut.done():
                job["gaia"] = _gaia_result(gaia_fut)
            if job.get("cancel") or time.time() - job["polled"] > ABANDON_AFTER_S:
                # The page asked to stop (a new search replaced this one), or nobody is watching
                # (tab closed): free the pool for other jobs.
                for f in todo:
                    f.cancel()
                job.update(status="error", error="cancelled: a newer search replaced this one" if job.get("cancel")
                           else "cancelled: the page stopped asking for this search")
                return
        if job["gaia"] is None:
            job["stage"] = "Querying Gaia DR3"
            job["gaia"] = _gaia_result(gaia_fut)
        job["elapsed_s"] = round(time.time() - t0, 1)
        job["status"] = "done"
    except Exception as e:
        traceback.print_exc()
        job.update(status="error", error=str(e))


@app.post("/api/jobs")
def api_job(ra: float | None = None, dec: float | None = None, fov: float = Query(5.0, gt=0.5, le=MAX_FOV_ARCMIN),
            pmra: float = 0.0, pmdec: float = 0.0, epoch: float | None = None, moving: str | None = None):
    """Start a search: a fixed sky position (ra, dec, optional proper motion) or, with `moving`,
    a solar-system object by name or NAIF id."""
    if not moving and (ra is None or dec is None):
        raise HTTPException(422, "give ra and dec, or moving=<solar-system object>")
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "status": "running", "stage": "Queued", "done": 0, "total": 0, "created": time.time(),
           "ready": [], "failed": 0, "gaia": None, "meta": None, "polled": time.time()}
    JOBS[jid] = job
    threading.Thread(target=_run_job, args=(job, ra, dec, fov, pmra, pmdec, epoch, moving), daemon=True).start()
    # forget old jobs
    for k in [k for k, v in JOBS.items() if time.time() - v["created"] > 3600]:
        JOBS.pop(k, None)
    return {"id": jid}


@app.get("/api/simbad")
def api_simbad(ra: float, dec: float, radius: float = Query(0.08, gt=0, le=0.3)):
    """Named objects (SIMBAD) around a position, for labels and the selected-object card."""
    try:
        return {"objects": sx.simbad_objects(ra, dec, radius)}
    except Exception as e:
        raise HTTPException(502, str(e))


@app.delete("/api/jobs/{jid}")
def api_job_cancel(jid: str):
    """Stop a search the page no longer wants; its queued reads are dropped within a couple of seconds."""
    job = JOBS.get(jid)
    if job:
        job["cancel"] = True
    return {"ok": True}


@app.get("/api/jobs/{jid}")
def api_job_status(jid: str, since: int = 0, gaia: int = 1):
    """Progress plus the frames finished since index `since` (the client passes back `next`)."""
    job = JOBS.get(jid)
    if not job:
        raise HTTPException(404, "unknown job")
    job["polled"] = time.time()
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
