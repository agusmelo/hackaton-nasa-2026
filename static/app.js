// SPHEREx Motion Viewer: client side.
// The server sends every exposure reprojected onto one north-up grid (background-subtracted, MJy/sr).
// Everything else (stacking, differencing, stretch, photometry, spectra) happens here so it stays interactive.
"use strict";

const DET_BANDS = { 1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.00] };
const PRESETS = [
  { label: "Barnard's Star", q: "Barnard's star", note: "10″/yr" },
  { label: "Epsilon Indi B", q: "eps Ind B", note: "brown dwarf pair" },
  { label: "WISE 0855", q: "WISE J085510.83-071442.5", note: "fast brown dwarf" },
  { label: "RW Aurigae", q: "RW Aur", note: "variable" },
  { label: "R Draconis", q: "R Dra", note: "Mira variable" },
];
const HARD_FLAGS = new Set(["OVERFLOW", "NONLINEAR", "TRANSIENT", "SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD"]);
const EPOCH_COLORS = ["#59c2ff", "#ff9e3d", "#7bd88f", "#d78bff", "#ff6b6b", "#ffd866", "#5ee6d0", "#c0c0c0"];

const $ = (s) => document.querySelector(s);
const S = {
  data: null, frames: [], dets: new Set([1, 2, 3, 4, 5, 6]), mode: "epoch",
  seq: [], idx: 0, playing: true, speed: 3, stackCache: new Map(),
  target: null, query: "", fov: 5, phot: { mode: "target", ra: null, dec: null }, embed: false,
  loadId: 0, failed: 0,
  zoom: 1, cx: 0, cy: 0,  // view centre in image pixels (edge coordinates, 0..npix)
};
// Colour mode: which detectors feed each channel (short wavelengths blue, long red).
const RGB_DETS = { r: [5, 6], g: [3, 4], b: [1, 2] };

// ------------------------------------------------------------------ helpers
const d2r = Math.PI / 180;
function decyear(mjd) { return 2000.0 + (mjd - 51544.5) / 365.25; }
function propagate(ra, dec, pmra, pmdec, from, to) {
  const dt = to - from;
  return [ra + (pmra * dt / 3.6e6) / Math.cos(dec * d2r), dec + pmdec * dt / 3.6e6];
}
function skyToPix(ra, dec) {
  const { ra: a0, dec: d0 } = S.data.center, n = S.data.npix, s = S.data.scale / 3600;
  const a = ra * d2r, d = dec * d2r, A0 = a0 * d2r, D0 = d0 * d2r;
  const D = Math.sin(D0) * Math.sin(d) + Math.cos(D0) * Math.cos(d) * Math.cos(a - A0);
  const xi = Math.cos(d) * Math.sin(a - A0) / D / d2r;
  const eta = (Math.cos(D0) * Math.sin(d) - Math.sin(D0) * Math.cos(d) * Math.cos(a - A0)) / D / d2r;
  const c = (n - 1) / 2;
  return [c - xi / s, c - eta / s]; // [col, row], row 0 = north
}
function pixToSky(col, row) {
  const { ra: a0, dec: d0 } = S.data.center, n = S.data.npix, s = S.data.scale / 3600;
  const c = (n - 1) / 2;
  const xi = -(col - c) * s * d2r, eta = -(row - c) * s * d2r;
  const A0 = a0 * d2r, D0 = d0 * d2r, rho = Math.hypot(xi, eta);
  if (rho === 0) return [a0, d0];
  const cc = Math.atan(rho);
  const dec = Math.asin(Math.cos(cc) * Math.sin(D0) + eta * Math.sin(cc) * Math.cos(D0) / rho);
  const ra = A0 + Math.atan2(xi * Math.sin(cc), rho * Math.cos(D0) * Math.cos(cc) - eta * Math.sin(D0) * Math.sin(cc));
  return [((ra / d2r) % 360 + 360) % 360, dec / d2r];
}
function fmtRA(ra) { const h = ra / 15, hh = Math.floor(h), m = (h - hh) * 60, mm = Math.floor(m), ss = (m - mm) * 60; return `${String(hh).padStart(2, "0")}h${String(mm).padStart(2, "0")}m${ss.toFixed(2).padStart(5, "0")}s`; }
function fmtDec(dec) { const sg = dec < 0 ? "−" : "+", a = Math.abs(dec), dd = Math.floor(a), m = (a - dd) * 60, mm = Math.floor(m), ss = (m - mm) * 60; return `${sg}${String(dd).padStart(2, "0")}°${String(mm).padStart(2, "0")}′${ss.toFixed(1).padStart(4, "0")}″`; }
function b64f32(s) { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Float32Array(u.buffer); }
function median(vals) { if (!vals.length) return NaN; vals.sort((a, b) => a - b); const m = vals.length >> 1; return vals.length % 2 ? vals[m] : 0.5 * (vals[m - 1] + vals[m]); }
function pixelMedian(arrs) {
  const n = arrs[0].length, out = new Float32Array(n), tmp = [];
  for (let p = 0; p < n; p++) {
    tmp.length = 0;
    for (const a of arrs) { const v = a[p]; if (v === v) tmp.push(v); }
    out[p] = tmp.length ? median(tmp) : NaN;
  }
  return out;
}
function percentile(sample, q) { const s = sample.filter((v) => v === v).sort((a, b) => a - b); if (!s.length) return 0; return s[Math.min(s.length - 1, Math.max(0, Math.round((q / 100) * (s.length - 1))))]; }

// ------------------------------------------------------------------ loading
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch (_) { } throw new Error(m); }
  return r.json();
}
function setStatus(text, frac, isError) {
  const st = $("#status");
  st.classList.remove("hidden");
  st.classList.toggle("error", !!isError);
  $("#stage").textContent = text;
  $("#barfill").style.width = `${Math.round((frac || 0) * 100)}%`;
  st.querySelector(".bar").style.display = isError ? "none" : "";
}

async function load(query, fov, opts = {}) {
  S.query = query; S.fov = fov;
  try {
    setStatus(`Resolving “${query}”…`, 0.02);
    let tgt;
    if (opts.ra != null) tgt = { name: query || null, ra: opts.ra, dec: opts.dec, pmra: opts.pmra || 0, pmdec: opts.pmdec || 0, epoch: opts.epoch ?? null };
    else tgt = await api(`/api/resolve?q=${encodeURIComponent(query)}`);
    S.target = tgt;
    const p = new URLSearchParams({ ra: tgt.ra, dec: tgt.dec, fov, pmra: tgt.pmra || 0, pmdec: tgt.pmdec || 0 });
    if (tgt.epoch != null) p.set("epoch", tgt.epoch);
    const { id } = await api(`/api/jobs?${p}`, { method: "POST" });
    const myLoad = ++S.loadId;  // a newer search cancels this loop
    let since = 0, started = false, needGaia = true, lastHeavy = 0;
    for (;;) {
      const job = await api(`/api/jobs/${id}?since=${since}&gaia=${needGaia ? 1 : 0}`);
      if (myLoad !== S.loadId) return;
      if (job.status === "error") throw new Error(job.error);
      if (job.meta && !started) { start(job.meta); started = true; }
      if (started && job.gaia) { S.data.gaia = job.gaia; needGaia = false; }
      if (started && job.frames.length) {
        addFrames(job.frames); since = job.next;
        if (performance.now() - lastHeavy > 4000) { refreshMeasurements(); lastHeavy = performance.now(); }
      }
      if (job.status === "done") { S.failed = job.failed || 0; break; }
      const frac = job.total ? 0.05 + 0.95 * job.done / job.total : 0.04;
      setStatus(`${job.stage}${job.total ? ` · ${job.done}/${job.total}` : ""}${started && job.total > 40 && job.done < job.total ? " · images appear as they arrive; a field is cached after its first visit" : ""}`, frac);
      await new Promise((r) => setTimeout(r, 600));
    }
    refreshMeasurements();
    render();
    $("#status").classList.add("hidden");
  } catch (e) {
    setStatus(`Could not load: ${e.message}`, 0, true);
  }
}

// Called once the image list is known: the viewer opens empty and fills in.
function start(meta) {
  S.data = { ...meta, gaia: [] };
  S.frames = [];
  S.failed = 0;
  S.stackCache.clear();
  S.phot = { mode: "target", ra: null, dec: null };
  S.idx = 0;
  resetZoom();
  $("#main").classList.remove("hidden");
  buildDets();
  rebuild();
  updateTitle();
  setupAladin();
  updateURL();
}

function addFrames(list) {
  for (const f of list) { f.arr = b64f32(f.data); delete f.data; f.decyear = decyear(f.mjd_avg || f.mjd); f.flags_near = f.flags_near || []; S.frames.push(f); }
  S.frames.sort((a, b) => a.mjd - b.mjd);
  S.stackCache.clear();
  updateDetCounts();
  updateTitle();
  rebuild();
}

function refreshMeasurements() { computePhotometry(); drawPlots(); buildTable(); updateTitle(); }

function updateTitle() {
  const t = S.target, data = S.data;
  $("#tname").textContent = t.name ? t.name.replace(/^(NAME |V\*\s+|\*\s+)/, "") : "Custom position";
  const pm = Math.hypot(t.pmra || 0, t.pmdec || 0);
  const loading = S.frames.length + S.failed < data.total ? ` of ${data.total}` : "";
  $("#tcoords").textContent = `${fmtRA(data.center.ra)} ${fmtDec(data.center.dec)} (at 2026.0)` +
    (pm ? ` · proper motion ${(pm / 1000).toFixed(2)}″/yr ≈ ${(pm / 1000 / data.scale).toFixed(2)} SPHEREx px/yr` : "") +
    ` · ${S.frames.length}${loading} exposures · ${data.epochs.length} epochs` +
    (S.failed ? ` · ${S.failed} could not be read (IRSA busy; reload to retry)` : "");
}

// ------------------------------------------------------------------ sequence building
function selectedFrames() { return S.frames.filter((f) => S.dets.has(f.detector)); }

function epochStacks(dets) {
  const key = "E" + [...dets].sort().join("");
  if (S.stackCache.has(key)) return S.stackCache.get(key);
  const out = [];
  S.data.epochs.forEach((e, ei) => {
    const fs = S.frames.filter((f) => f.epoch === ei && dets.has(f.detector));
    if (!fs.length) return;
    // mean detector orientation of the epoch (circular mean of the exposures' roll angles)
    let sx = 0, sy = 0;
    for (const f of fs) if (f.roll != null) { sx += Math.cos(f.roll * d2r); sy += Math.sin(f.roll * d2r); }
    const roll = sx || sy ? Math.atan2(sy, sx) / d2r : null;
    out.push({ arr: pixelMedian(fs.map((f) => f.arr)), epoch: ei, decyear: e.decyear, n: fs.length, roll,
               label: `Epoch ${ei + 1} · ${e.label} · median of ${fs.length} exposures` });
  });
  S.stackCache.set(key, out);
  return out;
}

function rgbStacks() {
  // One colour frame per epoch; each channel is the median of its detectors (restricted to the selected ones).
  const chan = {};
  for (const k of ["r", "g", "b"]) {
    const dets = new Set(RGB_DETS[k].filter((d) => S.dets.has(d)));
    chan[k] = new Map((dets.size ? epochStacks(dets) : []).map((s) => [s.epoch, s]));
  }
  const out = [];
  S.data.epochs.forEach((e, ei) => {
    const r = chan.r.get(ei), g = chan.g.get(ei), b = chan.b.get(ei);
    if (!r && !g && !b) return;
    const n = (r?.n || 0) + (g?.n || 0) + (b?.n || 0);
    out.push({ rgb: [r?.arr || null, g?.arr || null, b?.arr || null], arr: (r || g || b).arr, epoch: ei, decyear: e.decyear, n,
               label: `Epoch ${ei + 1} · ${e.label} · colour from ${n} exposures (blue 0.75–1.6, green 1.6–3.8, red 3.8–5 µm)` });
  });
  return out;
}

function rebuild() {
  const stacks = epochStacks(S.dets);
  if (S.mode === "epoch") S.seq = stacks;
  else if (S.mode === "rgb") S.seq = rgbStacks();
  else if (S.mode === "diff") {
    S.seq = stacks.map((s, i) => {
      const rest = stacks.filter((_, j) => j !== i);
      if (!rest.length) return { ...s, label: s.label + " (need ≥2 epochs)" };
      // Prefer reference epochs taken with the same detector orientation: SPHEREx flips ~180° every six
      // months, and subtracting a flipped PSF leaves a residual on every star.
      const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
      const same = s.roll == null ? [] : rest.filter((o) => o.roll != null && angDiff(s.roll, o.roll) < 45);
      const used = same.length ? same : rest;
      const ref = used.length === 1 ? used[0].arr : pixelMedian(used.map((o) => o.arr));
      const arr = new Float32Array(s.arr.length);
      for (let p = 0; p < arr.length; p++) arr[p] = s.arr[p] - ref[p];
      const what = same.length ? `epoch${used.length > 1 ? "s" : ""} ${used.map((o) => o.epoch + 1).join(", ")} (same orientation)` : "other epochs (none with the same orientation)";
      return { ...s, arr, diff: true, label: `${s.label.replace(" · median", ` − ${what} · median`)}` };
    });
  } else {
    S.seq = selectedFrames().map((f) => ({
      arr: f.arr, epoch: f.epoch, decyear: f.decyear, frame: f,
      label: `${f.date.replace("T", " ")} · D${f.detector} · λ ${f.wavelength ? f.wavelength.toFixed(3) : "?"} µm · epoch ${f.epoch + 1}`,
    }));
  }
  computeLimits();
  $("#slider").max = Math.max(0, S.seq.length - 1);
  S.idx = Math.min(S.idx, Math.max(0, S.seq.length - 1));
  render();
}

function sampleOf(arrs) {
  const sample = [];
  for (const a of arrs) { if (!a) continue; const step = Math.max(1, Math.floor(a.length / 1500)); for (let p = 0; p < a.length; p += step) if (a[p] === a[p]) sample.push(a[p]); }
  return sample;
}

function computeLimits() {
  const c = +$("#contrast").value;
  if (S.mode === "diff") {
    // Scale to the background noise, not to the brightest residual: a saturated star's residual
    // would otherwise flatten everything else to grey. Slider maps to 2..8 sigma.
    const s = sampleOf(S.seq.map((it) => it.arr));
    const med = median(s.slice());
    const sigma = 1.4826 * median(s.map((v) => Math.abs(v - med))) || 1e-6;
    const k = 2 + ((c - 80) / 19.9) * 6;
    S.lim = [med - k * sigma, med + k * sigma];
  } else if (S.mode === "rgb") {
    // Scale every channel by its own background noise so empty sky is neutral grey and a source's
    // colour shows in which bands it stands out. Limits: -1.5 sigma .. K sigma, K shared by the channels.
    const stats = [0, 1, 2].map((ch) => {
      const s = sampleOf(S.seq.map((it) => it.rgb[ch]));
      if (!s.length) return null;
      const med = median(s.slice());
      return { s, med, sigma: 1.4826 * median(s.map((v) => Math.abs(v - med))) || 1e-6 };
    });
    const pooled = [];
    for (const st of stats) if (st) for (const v of st.s) pooled.push((v - st.med) / st.sigma);
    const K = Math.max(8, percentile(pooled, c));
    S.limRGB = stats.map((st) => (st ? [st.med - 1.5 * st.sigma, st.med + K * st.sigma] : [0, 1]));
  } else {
    const s = sampleOf(S.seq.map((it) => it.arr));
    S.lim = [percentile(s, 2), percentile(s, c)];
  }
}

// ------------------------------------------------------------------ rendering
const view = $("#view"), ctx = view.getContext("2d");
const off = document.createElement("canvas"), octx = off.getContext("2d");

// ---- zoom / pan: the visible window in image pixels
function viewRect() {
  const n = S.data.npix, w = n / S.zoom;
  const x = Math.min(n - w, Math.max(0, S.cx - w / 2)), y = Math.min(n - w, Math.max(0, S.cy - w / 2));
  return { x, y, w };
}
function resetZoom() { S.zoom = 1; if (S.data) { S.cx = S.data.npix / 2; S.cy = S.data.npix / 2; } syncZoomUI(); }
function syncZoomUI() { const el = $("#zoomlabel"); if (el) el.textContent = `${S.zoom.toFixed(S.zoom < 10 ? 1 : 0)}×`; }
function zoomAt(factor, px, py) {
  // keep image point (px, py) under the same screen position
  const v = viewRect(), z = Math.min(12, Math.max(1, S.zoom * factor));
  const fx = (px - v.x) / v.w, fy = (py - v.y) / v.w, w = S.data.npix / z;
  S.zoom = z; S.cx = px - fx * w + w / 2; S.cy = py - fy * w + w / 2;
  const c = viewRect(); S.cx = c.x + c.w / 2; S.cy = c.y + c.w / 2;  // store the clamped centre
  syncZoomUI(); render();
}
// mouse event -> image coordinates: edge coords (ex, ey) and pixel-centre coords (col, row)
function evToPix(e) {
  const rect = view.getBoundingClientRect(), v = viewRect();
  const ex = v.x + ((e.clientX - rect.left) / rect.width) * v.w, ey = v.y + ((e.clientY - rect.top) / rect.height) * v.w;
  return { ex, ey, col: ex - 0.5, row: ey - 0.5 };
}

function stretchValue(v, lo, hi, st) {
  let t = Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1)));
  if (st === "asinh") t = Math.asinh(t * 10) / Math.asinh(10);
  else if (st === "log") t = Math.log10(1 + 1000 * t) / 3;
  return t;
}

function render() {
  if (!S.data || !S.seq.length) {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, view.width, view.height);
    $("#framelabel").textContent = !S.data ? "" : S.frames.length ? "No exposures for the selected detectors" : "Waiting for the first exposures…";
    return;
  }
  const n = S.data.npix, it = S.seq[S.idx];
  off.width = n; off.height = n;
  const img = octx.createImageData(n, n), d = img.data;
  const st = S.mode === "diff" ? "linear" : $("#stretch").value, inv = $("#invert").checked;
  if (it.rgb) {
    for (let p = 0; p < n * n; p++) {
      let any = false;
      for (let ch = 0; ch < 3; ch++) {
        const a = it.rgb[ch], v = a ? a[p] : NaN;
        if (v === v) { any = true; d[4 * p + ch] = Math.round(stretchValue(v, S.limRGB[ch][0], S.limRGB[ch][1], st) * 255); }
        else d[4 * p + ch] = 0;
      }
      if (!any) { d[4 * p] = 16; d[4 * p + 1] = 18; d[4 * p + 2] = 40; }
      d[4 * p + 3] = 255;
    }
  } else {
    const [lo, hi] = S.lim;
    for (let p = 0; p < n * n; p++) {
      const v = it.arr[p];
      if (v !== v) { d[4 * p] = 16; d[4 * p + 1] = 18; d[4 * p + 2] = 40; }
      else { let t = stretchValue(v, lo, hi, st); if (inv) t = 1 - t; d[4 * p] = d[4 * p + 1] = d[4 * p + 2] = Math.round(t * 255); }
      d[4 * p + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  const v = viewRect();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, view.width, view.height);
  ctx.drawImage(off, v.x, v.y, v.w, v.w, 0, 0, view.width, view.height);
  drawOverlays(it);
  $("#framelabel").textContent = `${S.idx + 1}/${S.seq.length} · ${it.label}`;
  $("#slider").value = S.idx;
  highlightRow(it.frame);
}

function drawOverlays(it) {
  const n = S.data.npix, v = viewRect(), sc = view.width / v.w;
  const P = (col, row) => [(col + 0.5 - v.x) * sc, (row + 0.5 - v.y) * sc];
  ctx.lineWidth = 1.5;
  if ($("#ov-gaia").checked) {
    for (const g of S.data.gaia) {
      const [ra, dec] = propagate(g.ra, g.dec, g.pmra, g.pmdec, 2016.0, it.decyear);
      const [c, r] = skyToPix(ra, dec);
      if (c < -2 || r < -2 || c > n + 1 || r > n + 1) continue;
      const [x, y] = P(c, r);
      const fast = Math.hypot(g.pmra, g.pmdec) > 300;
      ctx.strokeStyle = fast ? "rgba(255,158,61,.95)" : "rgba(89,194,255,.55)";
      ctx.beginPath(); ctx.arc(x, y, Math.max(3, (20 - Math.min(19, g.g || 19)) * 0.9 + 3), 0, 2 * Math.PI); ctx.stroke();
    }
  }
  const t = S.target;
  if ($("#ov-target").checked && t) {
    const pos = targetAt(it.decyear);
    const [x, y] = P(...skyToPix(...pos));
    ctx.strokeStyle = "#ff4fd8"; ctx.lineWidth = 2;
    const a = 6, b = 16;
    ctx.beginPath();
    ctx.moveTo(x - b, y); ctx.lineTo(x - a, y); ctx.moveTo(x + a, y); ctx.lineTo(x + b, y);
    ctx.moveTo(x, y - b); ctx.lineTo(x, y - a); ctx.moveTo(x, y + a); ctx.lineTo(x, y + b);
    ctx.stroke();
    if (t.epoch != null && Math.hypot(t.pmra, t.pmdec) > 50) { // predicted track over the survey
      ctx.strokeStyle = "rgba(255,79,216,.45)"; ctx.setLineDash([4, 4]); ctx.beginPath();
      const e0 = S.data.epochs[0].decyear - 0.2, e1 = S.data.epochs.at(-1).decyear + 0.2;
      ctx.moveTo(...P(...skyToPix(...targetAt(e0)))); ctx.lineTo(...P(...skyToPix(...targetAt(e1)))); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  if ($("#ov-ap").checked) {
    const ep = it.epoch, pos = photPixel(ep);
    if (pos) {
      const [x, y] = P(...pos);
      ctx.strokeStyle = "#7bd88f"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, APER.r * sc, 0, 2 * Math.PI); ctx.stroke();
      ctx.setLineDash([3, 3]); ctx.strokeStyle = "rgba(123,216,143,.5)";
      ctx.beginPath(); ctx.arc(x, y, APER.r1 * sc, 0, 2 * Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, APER.r2 * sc, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
    }
  }
}

function targetAt(year) {
  const t = S.target;
  if (t.epoch == null) return [t.ra, t.dec];
  return propagate(t.ra, t.dec, t.pmra, t.pmdec, t.epoch, year);
}

// ------------------------------------------------------------------ photometry
const APER = { r: 2.0, r1: 4.0, r2: 7.0 };
let epochCentroids = [];

function photPixel(epoch) {
  if (epochCentroids[epoch]) return epochCentroids[epoch];
  return null;
}

function centroid(arr, c0, r0, rad) {
  const n = S.data.npix;
  let best = -Infinity, bc = c0, br = r0;
  for (let r = Math.floor(r0 - rad); r <= Math.ceil(r0 + rad); r++)
    for (let c = Math.floor(c0 - rad); c <= Math.ceil(c0 + rad); c++) {
      if (r < 1 || c < 1 || r >= n - 1 || c >= n - 1 || Math.hypot(c - c0, r - r0) > rad) continue;
      const v = arr[r * n + c]; if (v > best) { best = v; bc = c; br = r; }
    }
  let sw = 0, sc = 0, sr = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const v = arr[(br + dr) * n + bc + dc]; if (v > 0) { sw += v; sc += v * (bc + dc); sr += v * (br + dr); }
  }
  return sw > 0 ? [sc / sw, sr / sw] : [c0, r0];
}

// Ring used when the core is saturated: the unsaturated PSF wings still scale with the star's brightness.
const WING = { r1: 4, r2: 8, b1: 12, b2: 16 };

function ringSum(arr, c0, r0, rin, rout) {
  const n = S.data.npix; let sum = 0, nv = 0, nt = 0; const vals = [];
  for (let r = Math.floor(r0 - rout); r <= Math.ceil(r0 + rout); r++)
    for (let c = Math.floor(c0 - rout); c <= Math.ceil(c0 + rout); c++) {
      const d = Math.hypot(c - c0, r - r0);
      if (d < rin || d > rout) continue;
      nt++;
      if (r < 0 || c < 0 || r >= n || c >= n) continue;
      const v = arr[r * n + c];
      if (v === v) { sum += v; nv++; vals.push(v); }
    }
  return { sum, nv, nt, vals };
}

// Pick ONE wing ring per target (so every exposure is measured the same way): the innermost ring
// that is >=60% unmasked in >=75% of the saturated exposures and still leaves room for a background ring.
function chooseWingRing() {
  const half = (S.data.npix - 1) / 2;
  const sat = S.frames.filter((f) => {
    const p = epochCentroids[f.epoch]; if (!p) return false;
    const core = ringSum(f.arr, p[0], p[1], 0, APER.r); return core.nv < core.nt;
  });
  WING.ok = false;
  // Wing mode only when most exposures are saturated; then it is used for ALL exposures so units never mix.
  if (!S.frames.length || sat.length < 0.5 * S.frames.length) return;
  for (const [r1, r2] of [[4, 8], [6, 10], [8, 12], [10, 14], [12, 16]]) {
    if (r2 + 8 > half) break;
    const good = sat.filter((f) => { const p = epochCentroids[f.epoch], w = ringSum(f.arr, p[0], p[1], r1, r2); return w.nv >= 0.6 * w.nt; }).length;
    if (good >= 0.75 * sat.length) { Object.assign(WING, { r1, r2, b1: r2 + 4, b2: r2 + 8, ok: true }); return; }
  }
}

function aperture(arr, c0, r0) {
  const useWings = $("#wings").checked && WING.ok;
  const core = ringSum(arr, c0, r0, 0, APER.r);
  const ann = ringSum(arr, c0, r0, APER.r1, APER.r2).vals;
  if (!useWings && core.nt && core.nv === core.nt && ann.length >= 8) {
    const bg = median(ann.slice());
    const mad = median(ann.map((v) => Math.abs(v - bg))) * 1.4826;
    return { flux: core.sum - core.nv * bg, err: mad * Math.sqrt(core.nv * (1 + core.nv / ann.length)), wing: false };
  }
  if (!useWings) return null;
  // Saturated core: sum the PSF wings (WING.r1..r2 px), scaled up for masked pixels, minus a far background ring.
  const w = ringSum(arr, c0, r0, WING.r1, WING.r2), b = ringSum(arr, c0, r0, WING.b1, WING.b2).vals;
  if (w.nv < 0.6 * w.nt || b.length < 20) return null;
  const bg = median(b.slice()), mad = median(b.map((v) => Math.abs(v - bg))) * 1.4826;
  return { flux: (w.sum / w.nv - bg) * w.nt, err: mad * Math.sqrt(w.nt), wing: true };
}

function computePhotometry() {
  const allDets = new Set([1, 2, 3, 4, 5, 6]);
  const stacks = epochStacks(allDets);
  epochCentroids = [];
  for (const s of stacks) {
    const sky = S.phot.mode === "target" ? targetAt(s.decyear) : [S.phot.ra, S.phot.dec];
    let [c, r] = skyToPix(...sky);
    if ($("#track").checked) [c, r] = centroid(s.arr, c, r, 2.0);
    epochCentroids[s.epoch] = [c, r];
  }
  chooseWingRing();
  for (const f of S.frames) {
    const pos = epochCentroids[f.epoch];
    const res = pos ? aperture(f.arr, pos[0], pos[1]) : null;
    f.flux = res ? res.flux * f.mjy_per_unit : null;
    f.ferr = res ? res.err * f.mjy_per_unit : null;
    f.wing = !!(res && res.wing);
  }
  const where = S.phot.mode === "target" ? "at target" : `at ${fmtRA(S.phot.ra)} ${fmtDec(S.phot.dec)}`;
  $("#photwhere").textContent = `${where} · r=${APER.r} px (${(APER.r * S.data.scale).toFixed(0)}″), no aperture correction`;
}

// ------------------------------------------------------------------ plots
const PL = {
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: "#cfd6e4", size: 11 },
  margin: { l: 52, r: 12, t: 26, b: 40 }, legend: { orientation: "h", y: 1.18, font: { size: 10 } },
  xaxis: { gridcolor: "#263044", zerolinecolor: "#263044" }, yaxis: { gridcolor: "#263044", zerolinecolor: "#3a4660" },
};
function drawPlots() {
  if (typeof Plotly === "undefined") return;
  const hide = $("#hideflag").checked;
  const ok = (f) => f.flux != null && f.wavelength != null && !(hide && !f.wing && f.flags_near.some((x) => HARD_FLAGS.has(x)));
  const sym = (f) => (f.wing ? "diamond-open" : f.flags_near.some((x) => HARD_FLAGS.has(x)) ? "x-open" : "circle");
  const fs = S.frames.filter(ok);
  const masked = S.frames.filter((f) => f.flux == null).length;
  const note = fs.length ? [] : [{
    text: masked ? `No usable photometry here: the aperture contains masked pixels in all ${masked} exposures<br>(saturated / bad pixels; very bright stars like this saturate SPHEREx)`
                 : "No exposures pass the current filters",
    xref: "paper", yref: "paper", x: 0.5, y: 0.5, showarrow: false, font: { size: 11, color: "#e8d98a" },
  }];
  const hover = (f) => `${f.date.replace("T", " ")}<br>D${f.detector} λ=${f.wavelength.toFixed(3)} µm<br>${f.flux.toFixed(3)} ± ${f.ferr.toFixed(3)} mJy${f.wing ? " (PSF wings, relative)" : ""}${f.flags_near.length ? "<br>⚑ " + f.flags_near.join(", ") : ""}`;
  const nw = fs.filter((f) => f.wing).length;
  if (nw) note.push({ text: `◇ Target saturates SPHEREx: all ${nw} points measured from PSF wings (${WING.r1}–${WING.r2} px), relative units; compare at similar wavelengths`,
    xref: "paper", yref: "paper", x: 0, y: -0.32, xanchor: "left", showarrow: false, font: { size: 10, color: "#e8d98a" } });
  const traces = S.data.epochs.map((e, ei) => {
    const g = fs.filter((f) => f.epoch === ei);
    return {
      x: g.map((f) => f.wavelength), y: g.map((f) => f.flux), error_y: { array: g.map((f) => f.ferr), thickness: 1, width: 0, color: EPOCH_COLORS[ei % 8] + "88" },
      mode: "markers", type: "scatter", name: `Epoch ${ei + 1} (${e.label})`, customdata: g.map((f) => S.frames.indexOf(f)),
      marker: { color: EPOCH_COLORS[ei % 8], size: 6, symbol: g.map(sym) },
      text: g.map(hover), hoverinfo: "text",
    };
  });
  Plotly.react("spec", traces, { ...PL, annotations: note, title: { text: "Spectrum (each point = one exposure)", font: { size: 12 } },
    xaxis: { ...PL.xaxis, title: "Wavelength (µm)" }, yaxis: { ...PL.yaxis, title: "Flux density (mJy)" } },
    { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
  Plotly.react("lc", [{
    x: fs.map((f) => f.date.replace("T", " ")), y: fs.map((f) => f.flux), mode: "markers", type: "scatter",
    error_y: { array: fs.map((f) => f.ferr), thickness: 1, width: 0, color: "#ffffff33" },
    marker: { color: fs.map((f) => f.wavelength), colorscale: "Turbo", cmin: 0.75, cmax: 5.0, size: 6, symbol: fs.map(sym),
              colorbar: { title: { text: "λ µm", side: "right" }, thickness: 10, len: 0.9 } },
    customdata: fs.map((f) => S.frames.indexOf(f)), text: fs.map(hover), hoverinfo: "text", showlegend: false,
  }], { ...PL, annotations: note, title: { text: "Light curve (colour = wavelength)", font: { size: 12 } },
    xaxis: { ...PL.xaxis, title: "Date" }, yaxis: { ...PL.yaxis, title: "Flux density (mJy)" } },
    { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
  for (const id of ["spec", "lc"]) {
    const el = document.getElementById(id);
    el.removeAllListeners?.("plotly_click");
    el.on("plotly_click", (ev) => { const fi = ev.points[0].customdata; if (fi != null) jumpToFrame(S.frames[fi]); });
  }
}

// ------------------------------------------------------------------ exposure table
function buildTable() {
  const tb = $("#ftable tbody");
  const rows = S.frames.map((f, i) => {
    const flags = f.flags_near.map((x) => `<span class="flag ${HARD_FLAGS.has(x) ? "" : "soft"}">${x}</span>`).join("");
    return `<tr data-i="${i}"><td>${i + 1}</td><td class="mono">${f.date.replace("T", " ")}</td><td>${f.epoch + 1}</td><td>D${f.detector}</td>` +
      `<td class="mono">${f.wavelength ? f.wavelength.toFixed(3) : "–"}</td><td class="mono">${f.flux != null ? f.flux.toFixed(3) : "–"}</td>` +
      `<td>${flags}</td><td><a href="${f.url}" target="_blank" rel="noopener" title="${f.id} (${f.collection})">FITS</a></td></tr>`;
  });
  tb.innerHTML = rows.join("");
  $("#nframes").textContent = `${S.frames.length} · ${S.frames.filter((f) => f.flags_near.length).length} with flags near target`;
}
function highlightRow(f) {
  document.querySelectorAll("#ftable tr.cur").forEach((r) => r.classList.remove("cur"));
  if (!f) return;
  const r = document.querySelector(`#ftable tr[data-i="${S.frames.indexOf(f)}"]`);
  if (r) { r.classList.add("cur"); if (!S.playing) r.scrollIntoView({ block: "nearest" }); }
}
function jumpToFrame(f) {
  if (!S.dets.has(f.detector)) { S.dets.add(f.detector); syncDets(); }
  setMode("exp");
  S.playing = false; $("#play").textContent = "▶";
  S.idx = Math.max(0, S.seq.findIndex((it) => it.frame === f));
  render();
}

// ------------------------------------------------------------------ detectors / modes
function buildDets() {
  const box = $("#dets"); box.innerHTML = "";
  for (let d = 1; d <= 6; d++) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" value="${d}"><b>D${d}</b><small>${DET_BANDS[d][0].toFixed(2)}–${DET_BANDS[d][1].toFixed(2)} µm</small><small class="nexp" data-d="${d}">0 exp</small>`;
    l.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) S.dets.add(d); else S.dets.delete(d);
      if (!S.dets.size) { S.dets.add(d); e.target.checked = true; }
      syncDets(); rebuild(); updateURL();
    });
    box.appendChild(l);
  }
  syncDets();
}
function updateDetCounts() {
  const n = [0, 0, 0, 0, 0, 0, 0];
  for (const f of S.frames) n[f.detector]++;
  document.querySelectorAll("#dets .nexp").forEach((el) => (el.textContent = `${n[+el.dataset.d]} exp`));
}
function syncDets() { document.querySelectorAll("#dets label").forEach((l) => { const d = +l.querySelector("input").value; l.querySelector("input").checked = S.dets.has(d); l.classList.toggle("on", S.dets.has(d)); }); }
function setMode(m) {
  S.mode = m;
  document.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("on", b.dataset.v === m));
  rebuild();
  updateURL();
}

// ------------------------------------------------------------------ Aladin context
let aladin = null, aladinOverlay = null, hipsUrl = null;
// The AllWISE colour survey is served by several mirrors. CDS (the default Aladin uses) can be down,
// so try each in turn and use the first that answers.
const ALLWISE_MIRRORS = [
  ["IRSA", "https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1"],
  ["ESA", "https://skies.esac.esa.int/AllWISEColor"],
  ["CDS", "https://alasky.cds.unistra.fr/AllWISE/RGB-W4-W2-W1"],
];
async function pickHips() {
  if (hipsUrl) return hipsUrl;
  for (const [name, url] of ALLWISE_MIRRORS) {
    try {
      const r = await fetch(`${url}/properties`, { signal: AbortSignal.timeout(7000) });
      // a mirror that is down may still answer 200 with an HTML error page
      if (r.ok && (await r.text()).includes("hips_")) { hipsUrl = url; $("#hipssrc").textContent = `AllWISE colour · ${name}`; return url; }
    } catch (_) { /* try the next mirror */ }
  }
  throw "no AllWISE image server is reachable right now";
}
function setupAladin() {
  if (S.embed) return;
  if (typeof A === "undefined") { window.addEventListener("aladin-ready", setupAladin, { once: true }); return; }
  const { ra, dec } = S.data.center, n = S.data.npix;
  const corners = [[-0.5, -0.5], [n - 0.5, -0.5], [n - 0.5, n - 0.5], [-0.5, n - 0.5]].map(([c, r]) => pixToSky(c, r));
  Promise.all([A.init, pickHips()]).then(([, survey]) => {
    if (!aladin) {
      aladin = A.aladin("#aladin", { survey, fov: (S.fov / 60) * 3, target: `${ra} ${dec}`,
        showLayersControl: false, showGotoControl: false, showFullscreenControl: false, showFrame: false,
        showZoomControl: false, showProjectionControl: false, showCooGridControl: false, showSimbadPointerControl: false, showSettingsControl: false, showShareControl: false, showContextMenu: false });
      aladinOverlay = A.graphicOverlay({ color: "#ff9e3d", lineWidth: 2 });
      aladin.addOverlay(aladinOverlay);
    } else {
      aladin.gotoRaDec(ra, dec); aladin.setFoV((S.fov / 60) * 3); aladinOverlay.removeAll();
    }
    aladinOverlay.add(A.polygon(corners));
  }).catch((e) => { $("#aladin").innerHTML = `<p class="hint">Sky context unavailable: ${e}</p>`; });
}

// ------------------------------------------------------------------ URL state
function updateURL() {
  const p = new URLSearchParams();
  if (S.target?.name && S.query && !/^[\d\s.+:hmsd°'"−-]+$/i.test(S.query)) p.set("target", S.query);
  else if (S.target) { p.set("ra", S.target.ra.toFixed(6)); p.set("dec", S.target.dec.toFixed(6)); }
  p.set("fov", S.fov);
  if (S.mode !== "epoch") p.set("mode", S.mode);
  if (S.dets.size < 6) p.set("det", [...S.dets].sort().join(""));
  if (S.embed) p.set("embed", "1");
  history.replaceState(null, "", `?${p}`);
}

// ------------------------------------------------------------------ playback + events
let lastTick = 0;
function tick(ts) {
  if (S.playing && S.seq.length > 1 && ts - lastTick > 1000 / S.speed) {
    S.idx = (S.idx + 1) % S.seq.length; lastTick = ts; render();
  }
  requestAnimationFrame(tick);
}

function wire() {
  const box = $("#presets");
  for (const p of PRESETS) {
    const b = document.createElement("button"); b.type = "button";
    b.innerHTML = `${p.label}<span>${p.note}</span>`;
    b.onclick = () => { $("#q").value = p.q; load(p.q, +$("#fov").value); };
    box.appendChild(b);
  }
  $("#search").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#q").value.trim(); if (q) load(q, +$("#fov").value); });
  document.querySelectorAll("#mode button").forEach((b) => (b.onclick = () => setMode(b.dataset.v)));
  $("#play").onclick = () => { S.playing = !S.playing; $("#play").textContent = S.playing ? "❚❚" : "▶"; };
  $("#slider").oninput = (e) => { S.idx = +e.target.value; S.playing = false; $("#play").textContent = "▶"; render(); };
  $("#speed").oninput = (e) => (S.speed = +e.target.value);
  $("#contrast").oninput = () => { computeLimits(); render(); };
  for (const id of ["#stretch", "#invert", "#ov-gaia", "#ov-target", "#ov-ap"]) $(id).onchange = render;
  $("#track").onchange = () => { computePhotometry(); drawPlots(); buildTable(); render(); };
  $("#aprad").onchange = (e) => { APER.r = +e.target.value; APER.r1 = APER.r + 2; APER.r2 = APER.r + 5; computePhotometry(); drawPlots(); buildTable(); render(); };
  $("#hideflag").onchange = drawPlots;
  $("#wings").onchange = () => { computePhotometry(); drawPlots(); buildTable(); };
  $("#phot-reset").onclick = () => { S.phot = { mode: "target" }; computePhotometry(); drawPlots(); buildTable(); render(); };
  // Drag = pan, wheel = zoom, plain click = measure there, double click = reset view.
  let drag = null;
  view.addEventListener("pointerdown", (e) => {
    if (!S.data || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, cx: S.cx, cy: S.cy, moved: false };
    view.setPointerCapture(e.pointerId);
  });
  view.addEventListener("pointermove", (e) => {
    if (!S.data) return;
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved && S.zoom > 1) {
        const rect = view.getBoundingClientRect(), w = S.data.npix / S.zoom;
        S.cx = drag.cx - (dx / rect.width) * w; S.cy = drag.cy - (dy / rect.height) * w;
        const c = viewRect(); S.cx = c.x + c.w / 2; S.cy = c.y + c.w / 2;
        view.style.cursor = "grabbing"; render();
      }
      return;
    }
    if (!S.seq.length) return;
    const n = S.data.npix, { ex, ey } = evToPix(e), c = Math.floor(ex), r = Math.floor(ey);
    if (c < 0 || r < 0 || c >= n || r >= n) return;
    const [ra, dec] = pixToSky(c, r), v = S.seq[S.idx].arr[r * n + c];
    $("#hover").textContent = `${fmtRA(ra)} ${fmtDec(dec)} · ${v === v ? v.toFixed(3) : "no data"} MJy/sr`;
  });
  view.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const wasDrag = drag.moved; drag = null; view.style.cursor = "";
    if (wasDrag || !S.data) return;
    const { col, row } = evToPix(e);
    const [ra, dec] = pixToSky(col, row);
    S.phot = { mode: "fixed", ra, dec };
    refreshMeasurements(); render();
  });
  view.addEventListener("pointercancel", () => { drag = null; view.style.cursor = ""; });
  view.addEventListener("wheel", (e) => {
    if (!S.data) return;
    e.preventDefault();
    const { ex, ey } = evToPix(e);
    zoomAt(e.deltaY < 0 ? 1.25 : 0.8, ex, ey);
  }, { passive: false });
  view.addEventListener("dblclick", () => { if (S.data) { resetZoom(); render(); } });
  view.addEventListener("mouseleave", () => ($("#hover").textContent = ""));
  $("#zoomin").onclick = () => S.data && zoomAt(1.5, S.cx, S.cy);
  $("#zoomout").onclick = () => S.data && zoomAt(1 / 1.5, S.cx, S.cy);
  $("#zoomreset").onclick = () => { if (S.data) { resetZoom(); render(); } };
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" && e.target.type !== "range" && e.target.type !== "checkbox") return;
    if (!S.seq.length) return;
    if (e.key === " ") { e.preventDefault(); $("#play").click(); }
    else if (e.key === "ArrowRight") { S.playing = false; S.idx = (S.idx + 1) % S.seq.length; render(); }
    else if (e.key === "ArrowLeft") { S.playing = false; S.idx = (S.idx - 1 + S.seq.length) % S.seq.length; render(); }
  });
  $("#copylink").onclick = () => copy(location.href.replace(/[?&]embed=1/, ""), "#copylink");
  $("#copyembed").onclick = () => {
    const u = new URL(location.href); u.searchParams.set("embed", "1");
    copy(`<iframe src="${u}" width="560" height="760" style="border:0" title="SPHEREx Motion Viewer"></iframe>`, "#copyembed");
  };
  $("#ftable tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr"); if (!tr || e.target.tagName === "A") return;
    jumpToFrame(S.frames[+tr.dataset.i]);
  });
}
function copy(text, btn) {
  navigator.clipboard?.writeText(text).then(() => { const b = $(btn), t = b.textContent; b.textContent = "Copied"; setTimeout(() => (b.textContent = t), 1200); });
}

// ------------------------------------------------------------------ boot
wire();
requestAnimationFrame(tick);
(() => {
  const p = new URLSearchParams(location.search);
  S.embed = p.get("embed") === "1";
  document.body.classList.toggle("embed", S.embed);
  if (p.get("mode")) { S.mode = p.get("mode"); document.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("on", b.dataset.v === S.mode)); }
  if (p.get("det")) S.dets = new Set(p.get("det").split("").map(Number).filter((d) => d >= 1 && d <= 6));
  const fov = +(p.get("fov") || 5);
  const fsel = $("#fov");
  if (![...fsel.options].some((o) => +o.value === fov)) fsel.add(new Option(`${fov}′`, fov));
  fsel.value = String(fov);
  if (p.get("target")) { $("#q").value = p.get("target"); load(p.get("target"), fov); }
  else if (p.get("ra") && p.get("dec")) {
    const ra = +p.get("ra"), dec = +p.get("dec");
    $("#q").value = `${ra} ${dec}`;
    load(`${ra} ${dec}`, fov, { ra, dec });
  }
})();
