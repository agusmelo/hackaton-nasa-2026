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
  // Solar-system objects: found through IRSA's Moving Object Search Tool, frames follow the object.
  { label: "3I/ATLAS", q: "3I/ATLAS", note: "interstellar comet", moving: true },
  { label: "Ceres", q: "Ceres", note: "dwarf planet", moving: true },
];
// One colour per detector, short wavelengths blue to long wavelengths red (matches the Colour mode).
const DET_COLORS = { 1: "#6aa8ff", 2: "#5ad1e6", 3: "#7bd88f", 4: "#ffd866", 5: "#ff9e3d", 6: "#ff6b6b" };
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
  $("#welcome").classList.add("hidden");
  try {
    let tgt, p;
    $("#kind").value = opts.moving ? "moving" : "sky";
    syncKind();
    if (opts.moving) {
      // Solar-system object: the server asks IRSA MOST which exposures caught it and where it was in each.
      setStatus(`Looking up “${query}” in IRSA's Moving Object Search Tool (about a minute the first time)…`, 0.02);
      tgt = { name: query, moving: true, ra: null, dec: null, pmra: 0, pmdec: 0, epoch: null };
      p = new URLSearchParams({ moving: query, fov });
    } else {
      setStatus(`Resolving “${query}”…`, 0.02);
      if (opts.ra != null) tgt = { name: null, ra: opts.ra, dec: opts.dec, pmra: opts.pmra || 0, pmdec: opts.pmdec || 0, epoch: opts.epoch ?? null };
      else tgt = await api(`/api/resolve?q=${encodeURIComponent(query)}`);
      p = new URLSearchParams({ ra: tgt.ra, dec: tgt.dec, fov, pmra: tgt.pmra || 0, pmdec: tgt.pmdec || 0 });
      if (tgt.epoch != null) p.set("epoch", tgt.epoch);
    }
    S.target = tgt;
    S.keepSkyView = !!opts.keepSkyView;  // field picked in the sky panel: do not reset its zoom
    // Tell the server to drop the search this one replaces, so its reads stop competing with ours.
    if (S.jobId) fetch(`/api/jobs/${S.jobId}`, { method: "DELETE" }).catch(() => { });
    const { id } = await api(`/api/jobs?${p}`, { method: "POST" });
    S.jobId = id;
    const myLoad = ++S.loadId;  // a newer search cancels this loop
    let since = 0, started = false, needGaia = true, lastHeavy = 0;
    for (;;) {
      const job = await api(`/api/jobs/${id}?since=${since}&gaia=${needGaia ? 1 : 0}`);
      if (myLoad !== S.loadId) return;
      if (job.status === "error") throw new Error(job.error);
      if (job.meta && !started) { start(job.meta); started = true; }
      if (started && job.gaia) { S.data.gaia = job.gaia; needGaia = false; buildObjects(); }
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
    drawSkyTrack();
    $("#status").classList.add("hidden");
  } catch (e) {
    setStatus(`Could not load: ${e.message}`, 0, true);
  }
}

// Called once the image list is known: the viewer opens empty and fills in.
function start(meta) {
  S.data = { ...meta, gaia: [] };
  if (meta.moving) S.target.name = meta.object;  // the name MOST resolved, e.g. "1 Ceres (A801 AA)"
  document.body.classList.toggle("is-moving", !!meta.moving);
  S.frames = [];
  S.failed = 0;
  S.stackCache.clear();
  S.phot = { mode: "target", ra: null, dec: null };
  S.objects = []; S.hoverObj = null;
  if (!meta.moving) {
    // names and object types for the field, from SIMBAD; the viewer works without them
    const myData = S.data;
    api(`/api/simbad?ra=${meta.center.ra}&dec=${meta.center.dec}&radius=${(meta.fov_arcmin / 60 * 0.75 + 0.01).toFixed(4)}`)
      .then((d) => { if (S.data !== myData) return; S.data.simbad = d.objects; buildObjects(); refreshMeasurements(); render(); })
      .catch(() => { });
  }
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
  if (data.moving) {
    const o = data.orbit || {}, num = (k, d) => (o[k] != null ? (+o[k]).toFixed(d) : null);
    const orbit = [num("semimajor_axis", 2) && `a = ${num("semimajor_axis", 2)} au`, num("eccentricity", 2) && `e = ${num("eccentricity", 2)}`,
                   num("inclination", 1) && `i = ${num("inclination", 1)}°`].filter(Boolean).join(", ");
    const v = S.frames.map((f) => f.vmag).filter((x) => x != null);
    setFacts([
      ["Kind", "Solar-system object"],
      orbit && ["Orbit", orbit],
      v.length && ["Predicted V", `${Math.min(...v).toFixed(1)}–${Math.max(...v).toFixed(1)}`],
      ["Exposures", `${S.frames.length}${loading}`],
      ["Visits", data.epochs.length],
      S.failed && ["Unread", `${S.failed} (reload to retry)`, "warn"],
    ], "Every frame is centred on the object, so the stars drift past.");
    return;
  }
  setFacts([
    ["Position (2026.0)", `${fmtRA(data.center.ra)} ${fmtDec(data.center.dec)}`],
    pm && ["Proper motion", `${(pm / 1000).toFixed(2)}″/yr · ${(pm / 1000 / data.scale).toFixed(2)} px/yr`],
    ["Exposures", `${S.frames.length}${loading}`],
    ["Epochs", data.epochs.length],
    S.failed && ["Unread", `${S.failed} (reload to retry)`, "warn"],
  ], "");
}

// Facts about the loaded target as labelled chips under its name (values are built here, never from page input).
function setFacts(items, note) {
  const box = $("#tcoords");
  box.textContent = "";
  for (const it of items) {
    if (!it) continue;
    const chip = document.createElement("span");
    chip.className = `fact${it[2] ? " " + it[2] : ""}`;
    const k = document.createElement("small"); k.textContent = it[0];
    const val = document.createElement("b"); val.textContent = it[1];
    chip.append(k, val);
    box.appendChild(chip);
  }
  $("#tnote").textContent = note;
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
function syncZoomUI() { const el = $("#zoomlabel"); if (el) el.textContent = `${S.zoom.toFixed(S.zoom < 10 ? 1 : 0)}×`; syncSkyPick(); }
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
  syncSkyView();
  $("#framelabel").textContent = `${S.idx + 1}/${S.seq.length} · ${it.label}`;
  $("#slider").value = S.idx;
  highlightRow(it.frame);
}

function drawOverlays(it) {
  const n = S.data.npix, v = viewRect(), sc = view.width / v.w;
  const P = (col, row) => [(col + 0.5 - v.x) * sc, (row + 0.5 - v.y) * sc];
  ctx.lineWidth = 1.5;
  const moving = S.data.moving, mid = (n - 1) / 2;
  if (!moving) {
    const showStars = $("#ov-gaia").checked, showNames = $("#ov-names").checked;
    const tag = (x, y, lines, color) => {  // small text block beside a mark, readable over any background
      ctx.font = "600 11px system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
      lines.forEach((ln, i) => {
        const ty = y + (i - (lines.length - 1) / 2) * 13;
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.85)"; ctx.strokeText(ln, x, ty);
        ctx.fillStyle = i ? "#cfd6e4" : color; ctx.fillText(ln, x, ty);
      });
      ctx.lineWidth = 1.5;
    };
    let named = 0;
    for (const o of S.objects || []) {
      const [c, r] = objPix(o, it.decyear);
      if (c < -2 || r < -2 || c > n + 1 || r > n + 1) continue;
      const [x, y] = P(c, r), fast = objPm(o) > 0.3, hov = o === S.hoverObj;
      const rad = o.src === "gaia" ? Math.max(3, (20 - Math.min(19, o.g || 19)) * 0.9 + 3) : 5;
      const color = o.src === "simbad" ? "#ffd866" : fast ? "#ff9e3d" : "#59c2ff";
      if (showStars || hov) {
        ctx.globalAlpha = hov ? 1 : o.src === "simbad" || fast ? 0.95 : 0.55;
        ctx.strokeStyle = color; ctx.lineWidth = hov ? 2.5 : 1.5;
        ctx.beginPath();
        if (o.src === "simbad") ctx.rect(x - rad, y - rad, 2 * rad, 2 * rad); else ctx.arc(x, y, rad, 0, 2 * Math.PI);
        ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1.5;
      }
      if (hov) {
        const facts = [o.g != null && `G ${o.g.toFixed(1)}`, objPm(o) > 0.02 && `${objPm(o).toFixed(2)}″/yr`, o.kind].filter(Boolean).join(" · ");
        tag(x + rad + 6, y, facts ? [objName(o), facts] : [objName(o)], color);
      } else if (showNames && objNotable(o) && named < 14) {
        named++;
        tag(x + rad + 5, y, [objShort(o)], color);
      }
    }
  }
  const t = S.target;
  if ($("#ov-target").checked && t) {
    // a moving object is at the centre of every frame by construction
    const [x, y] = moving ? P(mid, mid) : P(...skyToPix(...targetAt(it.decyear)));
    ctx.strokeStyle = "#ff4fd8"; ctx.lineWidth = 2;
    const a = 6, b = 16;
    ctx.beginPath();
    ctx.moveTo(x - b, y); ctx.lineTo(x - a, y); ctx.moveTo(x + a, y); ctx.lineTo(x + b, y);
    ctx.moveTo(x, y - b); ctx.lineTo(x, y - a); ctx.moveTo(x, y + a); ctx.lineTo(x, y + b);
    ctx.stroke();
    if (!moving && t.epoch != null && Math.hypot(t.pmra, t.pmdec) > 50) { // predicted track over the survey
      ctx.strokeStyle = "rgba(255,79,216,.45)"; ctx.setLineDash([4, 4]); ctx.beginPath();
      const e0 = S.data.epochs[0].decyear - 0.2, e1 = S.data.epochs.at(-1).decyear + 0.2;
      ctx.moveTo(...P(...skyToPix(...targetAt(e0)))); ctx.lineTo(...P(...skyToPix(...targetAt(e1)))); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  if ($("#ov-ap").checked) {
    const ep = it.epoch, pos = photPixel(ep), ph = S.phot;
    if (!moving && ph.mode === "fixed" && ph.epoch != null && Math.hypot(ph.pmra || 0, ph.pmdec || 0) > 50) {
      // path of the followed source over the survey
      ctx.strokeStyle = "rgba(123,216,143,.6)"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.beginPath();
      const e0 = S.data.epochs[0].decyear - 0.2, e1 = S.data.epochs.at(-1).decyear + 0.2;
      ctx.moveTo(...P(...skyToPix(...photSkyAt(e0)))); ctx.lineTo(...P(...skyToPix(...photSkyAt(e1)))); ctx.stroke(); ctx.setLineDash([]);
    }
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

// Offset of a pixel from the frame centre, in arcsec east/north (used when frames follow a moving object).
function offsetText(col, row) {
  const mid = (S.data.npix - 1) / 2, s = S.data.scale;
  const e = -(col - mid) * s, nn = -(row - mid) * s, f = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(0)}″`;
  return `ΔE ${f(e)} ΔN ${f(nn)}`;
}

// ------------------------------------------------------------------ following a clicked source
// Where the measured source is at a given date: the named target (catalogue proper motion), or a
// clicked source with the proper motion it was given (from Gaia, or measured in the images).
function photSkyAt(year) {
  const p = S.phot;
  if (p.mode === "target") return targetAt(year);
  if (p.epoch != null && (p.pmra || p.pmdec)) return propagate(p.ra, p.dec, p.pmra, p.pmdec, p.epoch, year);
  return [p.ra, p.dec];
}

// ---- known objects in the field: Gaia DR3 stars, with SIMBAD's name and type attached where SIMBAD
// lists the same Gaia id, plus SIMBAD objects Gaia does not have (galaxies, brown dwarfs, X-ray sources).
function buildObjects() {
  const byId = new Map(), objs = [];
  for (const g of S.data.gaia || []) {
    const o = { src: "gaia", id: g.id, ra: g.ra, dec: g.dec, pmra: g.pmra, pmdec: g.pmdec, epoch: 2016.0, g: g.g,
                plx: g.plx, plxErr: g.plx_err, bpRp: g.bp_rp, teff: g.teff, rv: g.rv, variable: g.variable,
                name: null, kind: null, sptype: null };
    byId.set(g.id, o); objs.push(o);
  }
  for (const s of S.data.simbad || []) {
    const name = /^Gaia DR\d /.test(s.name) ? null : s.name.replace(/^(NAME |V\*\s+|\*\s+)/, "");  // a bare Gaia id is not a name
    const o = s.gaia && byId.get(s.gaia);
    if (o) { o.name = name; o.kind = s.kind; o.sptype = s.sptype; }
    else objs.push({ src: "simbad", id: s.gaia, ra: s.ra, dec: s.dec, pmra: s.pmra, pmdec: s.pmdec, epoch: 2000.0, g: null,
                     plx: s.plx, plxErr: null, bpRp: null, teff: null, rv: null, variable: false, name, kind: s.kind, sptype: s.sptype });
  }
  S.objects = objs;
}
const objPm = (o) => Math.hypot(o.pmra || 0, o.pmdec || 0) / 1000;  // arcsec / yr
const objName = (o) => o.name || (o.id ? `Gaia DR3 ${o.id}` : o.kind || "Unnamed source");
const objShort = (o) => o.name || (o.id ? `Gaia …${o.id.slice(-5)}` : o.kind || "source");
function objPix(o, year) { return skyToPix(...propagate(o.ra, o.dec, o.pmra, o.pmdec, o.epoch, year)); }
// worth a permanent label: it has a real name, or it moves fast
const objNotable = (o) => !!o.name || objPm(o) > 0.3;

function nearestObject(col, row, year, maxPx = 1.5) {
  let best = null, bd = maxPx;
  for (const o of S.objects || []) {
    const [c, r] = objPix(o, year);
    const d = Math.hypot(c - col, r - row);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

function stackSigma(s) {
  if (s.sigma == null) {
    const v = sampleOf([s.arr]), med = median(v.slice());
    s.sigma = 1.4826 * median(v.map((x) => Math.abs(x - med))) || 1e-6;
  }
  return s.sigma;
}

// Brightest pixel within `rad` of (c0, r0), then the flux-weighted centre of the 5x5 pixels around it
// (only pixels above 20% of the peak, so noise and faint neighbours do not pull it).
function centroidAt(arr, c0, r0, rad) {
  const n = S.data.npix;
  let pk = -Infinity, bc = -1, br = -1;
  for (let r = Math.floor(r0 - rad); r <= Math.ceil(r0 + rad); r++)
    for (let c = Math.floor(c0 - rad); c <= Math.ceil(c0 + rad); c++) {
      if (r < 2 || c < 2 || r >= n - 2 || c >= n - 2 || Math.hypot(c - c0, r - r0) > rad) continue;
      const v = arr[r * n + c];
      if (v === v && v > pk) { pk = v; bc = c; br = r; }
    }
  if (bc < 0) return null;
  let sw = 0, sc = 0, sr = 0;
  for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
    const v = arr[(br + dr) * n + bc + dc];
    if (v === v && v > 0.2 * pk) { sw += v; sc += v * (bc + dc); sr += v * (br + dr); }
  }
  return sw > 0 ? { c: sc / sw, r: sr / sw, peak: pk } : null;
}

// Measure a source's motion from the images alone: find it in every epoch stack of the selected
// detectors (walking outwards in time from the epoch that was clicked, so a drifting source is
// followed), then fit a straight line to position against time.
function measureMotion(col, row, epoch) {
  const stacks = epochStacks(S.dets);
  if (!stacks.length) return null;
  let start = stacks.findIndex((s) => s.epoch === epoch);
  if (start < 0) start = 0;
  const pts = [];
  const walk = (from, step) => {
    let pc = col, pr = row;
    for (let i = from; i >= 0 && i < stacks.length; i += step) {
      const s = stacks[i], hit = centroidAt(s.arr, pc, pr, 2.5);
      if (!hit) continue;
      const snr = hit.peak / stackSigma(s);
      if (snr < 4) continue;
      pts.push({ t: s.decyear, c: hit.c, r: hit.r, snr, epoch: s.epoch });
      pc = hit.c; pr = hit.r;
    }
    return [pc, pr];
  };
  walk(start, 1);
  if (pts.length) { col = pts[0].c; row = pts[0].r; }
  walk(start - 1, -1);
  if (!pts.length) return null;
  pts.sort((a, b) => a.t - b.t);
  const n = pts.length, tm = pts.reduce((a, p) => a + p.t, 0) / n, span = pts[n - 1].t - pts[0].t;
  const mean = (k) => pts.reduce((a, p) => a + p[k], 0) / n;
  const c0 = mean("c"), r0 = mean("r"), stt = pts.reduce((a, p) => a + (p.t - tm) ** 2, 0);
  const slope = (k, m) => (stt > 0 ? pts.reduce((a, p) => a + (p.t - tm) * (p[k] - m), 0) / stt : 0);
  const vc = slope("c", c0), vr = slope("r", r0);
  // scatter of the epochs around the line gives the error; with only two epochs assume 0.25 px each
  let rms = 0.25;
  if (n > 2) {
    const ss = pts.reduce((a, p) => a + (p.c - c0 - vc * (p.t - tm)) ** 2 + (p.r - r0 - vr * (p.t - tm)) ** 2, 0);
    rms = Math.max(0.08, Math.sqrt(ss / (2 * (n - 2))));
  }
  const sc = S.data.scale, verr = stt > 0 ? rms / Math.sqrt(stt) : Infinity;
  const pmE = -vc * sc, pmN = -vr * sc, tot = Math.hypot(pmE, pmN), err = verr * sc;  // arcsec / yr
  return { n, span, tm, c0, r0, pmE, pmN, tot, err, significant: n >= 2 && span >= 0.3 && tot > 3 * err, pts };
}

// A click on the image: follow a Gaia star if there is one under it, otherwise measure the motion.
function pickSource(col, row, item) {
  const year = item.decyear;
  const o = nearestObject(col, row, year);
  if (o) return { mode: "fixed", ra: o.ra, dec: o.dec, pmra: o.pmra, pmdec: o.pmdec, epoch: o.epoch, source: o.src, obj: o };
  const m = measureMotion(col, row, item.epoch);
  if (!m) { const [ra, dec] = pixToSky(col, row); return { mode: "fixed", ra, dec, source: "none" }; }
  const [ra, dec] = pixToSky(m.c0, m.r0);
  return { mode: "fixed", ra, dec, epoch: m.tm, pmra: m.significant ? m.pmE * 1000 : 0, pmdec: m.significant ? m.pmN * 1000 : 0,
           source: "measured", fit: m, dets: [...S.dets].sort().join("") };
}

// ---- "who is this?" card for whatever the measurement circle is on
// The object being measured: the one that was clicked, or the catalogue object at the named target.
function selectedObject() {
  if (S.data.moving) return null;
  if (S.phot.mode === "fixed") return S.phot.obj || null;
  const e = S.data.epochs, year = e.length ? e[e.length >> 1].decyear : 2026.0;
  return nearestObject(...skyToPix(...targetAt(year)), year, 2.0);
}

function colourWord(bpRp) {
  return bpRp < 0.3 ? "blue-white" : bpRp < 0.8 ? "white-yellow" : bpRp < 1.3 ? "yellow-orange" : bpRp < 2.2 ? "orange-red" : "very red";
}

function renderObjCard() {
  const box = $("#objcard");
  box.textContent = "";  // rebuilt with text nodes only: names and types come from outside catalogues
  const add = (tag, cls, text, parent = box) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; parent.appendChild(el); return el; };
  const rows = [], links = [];
  let title, sub, sky = null;
  const o = selectedObject(), p = S.phot, t = S.target;
  if (S.data.moving) {
    const f = S.frames, rng = (k, d) => { const v = f.map((x) => x[k]).filter((x) => x != null); return v.length ? `${Math.min(...v).toFixed(d)}–${Math.max(...v).toFixed(d)}` : null; };
    title = t.name; sub = "Solar-system object · positions from IRSA MOST (JPL Horizons orbit)";
    const orb = S.data.orbit || {};
    if (orb.semimajor_axis) rows.push(["Orbit size", `${(+orb.semimajor_axis).toFixed(2)} au`]);
    if (orb.eccentricity) rows.push(["Eccentricity", `${(+orb.eccentricity).toFixed(2)}${+orb.eccentricity > 1 ? " (not bound to the Sun)" : ""}`]);
    if (orb.inclination) rows.push(["Inclination", `${(+orb.inclination).toFixed(1)}°`]);
    if (rng("sun_dist", 2)) rows.push(["From the Sun", `${rng("sun_dist", 2)} au`]);
    if (rng("geo_dist", 2)) rows.push(["From Earth", `${rng("geo_dist", 2)} au`]);
    if (rng("vmag", 1)) rows.push(["Predicted V", rng("vmag", 1)]);
  } else if (o) {
    title = p.mode === "target" && t.name ? t.name.replace(/^(NAME |V\*\s+|\*\s+)/, "") : objName(o);
    sub = [o.kind || (o.src === "gaia" ? "Star in Gaia DR3" : null), o.sptype && `spectral type ${o.sptype}`].filter(Boolean).join(" · ");
    if (o.g != null) rows.push(["Brightness", `G = ${o.g.toFixed(2)} mag`]);
    if (o.bpRp != null) rows.push(["Colour", `BP−RP = ${o.bpRp.toFixed(2)} (${colourWord(o.bpRp)})`]);
    if (o.teff != null) rows.push(["Temperature", `≈ ${Math.round(o.teff / 10) * 10} K`]);
    // a distance only when the parallax is well measured
    if (o.plx > 0 && (o.plxErr ? o.plx / o.plxErr > 5 : o.plx > 2)) {
      const pc = 1000 / o.plx;
      rows.push(["Distance", `${pc < 100 ? pc.toFixed(1) : Math.round(pc)} pc · ${Math.round(pc * 3.2616).toLocaleString("en")} light-years`]);
    }
    const pm = objPm(o);
    rows.push(["Proper motion", pm > 0.001 ? `${pm.toFixed(pm < 1 ? 3 : 2)}″/yr${pm > 0.02 ? " toward the " + compass(o.pmra, o.pmdec) : ""}` : "none measured"]);
    if (pm > 0.001) rows.push(["In SPHEREx", `${(pm / S.data.scale).toFixed(2)} px per year`]);
    if (o.rv != null) rows.push(["Radial velocity", `${o.rv > 0 ? "+" : ""}${o.rv.toFixed(1)} km/s (${o.rv > 0 ? "receding" : "approaching"})`]);
    if (o.variable) rows.push(["Variability", "flagged variable by Gaia"]);
    if (o.id) rows.push(["Gaia DR3 id", o.id]);
    sky = propagate(o.ra, o.dec, o.pmra, o.pmdec, o.epoch, 2026.0);
    links.push(o.name ? ["SIMBAD", `https://simbad.cfa.harvard.edu/simbad/sim-id?Ident=${encodeURIComponent(o.name)}`]
                      : ["Look up in SIMBAD", `https://simbad.cfa.harvard.edu/simbad/sim-coo?Coord=${sky[0].toFixed(5)}+${sky[1] >= 0 ? "%2B" : ""}${sky[1].toFixed(5)}&Radius=10&Radius.unit=arcsec`]);
  } else if (p.mode === "target") {
    title = t.name ? t.name.replace(/^(NAME |V\*\s+|\*\s+)/, "") : "Custom position";
    sub = [t.otype && `SIMBAD type ${t.otype}`, "no Gaia DR3 or SIMBAD object under the target"].filter(Boolean).join(" · ");
    const pm = Math.hypot(t.pmra || 0, t.pmdec || 0) / 1000;
    if (pm) rows.push(["Proper motion", `${pm.toFixed(2)}″/yr toward the ${compass(t.pmra, t.pmdec)}`]);
    sky = [S.data.center.ra, S.data.center.dec];
  } else {
    title = p.source === "measured" ? "Uncatalogued source" : "Empty position";
    sub = "Not in Gaia DR3 (brighter than G = 19) nor in SIMBAD";
    if (p.source === "measured") {
      const f = p.fit;
      rows.push(["Measured motion", `${f.tot.toFixed(1)} ± ${isFinite(f.err) ? f.err.toFixed(1) : "?"}″/yr${f.significant ? " toward the " + compass(f.pmE, f.pmN) : " (not significant)"}`]);
      rows.push(["From", `${f.n} epoch${f.n > 1 ? "s" : ""} over ${f.span.toFixed(1)} yr, detectors D${p.dets.split("").join("+D")}`]);
    }
    rows.push(["Position", `${fmtRA(p.ra)} ${fmtDec(p.dec)}`]);
    sky = [p.ra, p.dec];
    links.push(["Look up in SIMBAD", `https://simbad.cfa.harvard.edu/simbad/sim-coo?Coord=${p.ra.toFixed(5)}+${p.dec >= 0 ? "%2B" : ""}${p.dec.toFixed(5)}&Radius=15&Radius.unit=arcsec`]);
  }
  add("div", "objtitle", title);
  if (sub) add("div", "objsub", sub);
  const dl = add("dl", "objfacts");
  for (const [k, v] of rows) { add("dt", "", k, dl); add("dd", "", v, dl); }
  if (links.length) {
    const ln = add("div", "objlinks");
    for (const [label, href] of links) { const a = add("a", "", `${label} ↗`, ln); a.href = href; a.target = "_blank"; a.rel = "noopener"; }
  }
  box.classList.remove("hidden");
  markSky(sky, title);
}

// Same object, named, in the sky panel.
let skyCat = null;
function markSky(sky, name) {
  if (!aladin || typeof A === "undefined") return;
  try {
    if (!skyCat) {
      skyCat = A.catalog({ name: "Selected object", shape: "circle", sourceSize: 18, color: "#7bd88f",
                           displayLabel: true, labelColumn: "name", labelColor: "#7bd88f", labelFont: "600 13px sans-serif" });
      aladin.addCatalog(skyCat);
    }
    skyCat.removeAll();
    if (sky) skyCat.addSources([A.source(sky[0], sky[1], { name })]);
  } catch (_) { /* the label in the sky panel is a nicety */ }
}

function compass(pmE, pmN) {
  const pa = (Math.atan2(pmE, pmN) / d2r + 360) % 360;
  return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(pa / 45) % 8];
}

// One sentence saying what the measurement circle is doing.
function trackText() {
  const p = S.phot;
  if (S.data.moving) return "Click anywhere on the image to measure at that offset from the object.";
  if (p.mode === "target") return "Click a source to measure it: the circle follows Gaia stars, or the motion measured in the images.";
  if (p.source === "gaia" || p.source === "simbad") {
    const pm = Math.hypot(p.pmra, p.pmdec) / 1000, cat = p.source === "gaia" ? "Gaia's" : "SIMBAD's";
    return pm > 0.005
      ? `The circle follows ${objShort(p.obj)} with ${cat} proper motion: ${pm.toFixed(pm < 1 ? 3 : 2)}″/yr${pm > 0.05 ? " toward the " + compass(p.pmra, p.pmdec) : ""}.`
      : `The circle stays on ${objShort(p.obj)}: the catalogue gives it no measurable motion.`;
  }
  if (p.source === "measured") {
    const f = p.fit, dets = `D${p.dets.split("").join("+D")}`;
    const val = `${f.tot.toFixed(1)} ± ${isFinite(f.err) ? f.err.toFixed(1) : "?"}″/yr`;
    return f.significant
      ? `Not in Gaia. Motion measured in SPHEREx (${f.n} epochs over ${f.span.toFixed(1)} yr, ${dets}): ${val} toward the ${compass(f.pmE, f.pmN)}. The circle follows it.`
      : `Not in Gaia. No significant motion in ${f.n} epoch${f.n > 1 ? "s" : ""} (${dets}): ${val}. The circle stays on the source.`;
  }
  return "No source detected here in the selected detectors; measuring at the clicked position.";
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
    let c, r;
    if (S.data.moving) {
      // frames follow the object: measure at the centre, or at a clicked pixel offset from it
      const mid = (S.data.npix - 1) / 2;
      [c, r] = S.phot.mode === "pixel" ? [S.phot.col, S.phot.row] : [mid, mid];
    } else {
      [c, r] = skyToPix(...photSkyAt(s.decyear));
    }
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
  const where = S.phot.mode === "target" ? (S.data.moving ? "at the object" : "at target")
    : S.phot.mode === "pixel" ? `at ${offsetText(S.phot.col, S.phot.row)} from the object`
    : `at ${fmtRA(S.phot.ra)} ${fmtDec(S.phot.dec)}`;
  $("#trackinfo").textContent = trackText();
  renderObjCard();
  $("#photwhere").textContent = `${where} · r=${APER.r} px (${(APER.r * S.data.scale).toFixed(0)}″), no aperture correction`;
}

// ------------------------------------------------------------------ plots
const PL = {
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: "#cfd6e4", size: 11 },
  margin: { l: 54, r: 12, t: 8, b: 40 }, legend: { orientation: "h", y: -0.26, x: 0, font: { size: 10 } },
  hoverlabel: { bgcolor: "#0b0e14", bordercolor: "#263044", font: { color: "#e6e9ef", size: 11 } },
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
  $("#photnote").textContent = nw ? `◇ The target saturates SPHEREx: all ${nw} points are measured from the PSF wings (${WING.r1}–${WING.r2} px). Units are relative; compare at similar wavelengths.` : "";
  $("#photnote").classList.toggle("hidden", !nw);
  const traces = S.data.epochs.map((e, ei) => {
    const g = fs.filter((f) => f.epoch === ei);
    return {
      x: g.map((f) => f.wavelength), y: g.map((f) => f.flux), error_y: { array: g.map((f) => f.ferr), thickness: 1, width: 0, color: EPOCH_COLORS[ei % 8] + "88" },
      mode: "markers", type: "scatter", name: `Epoch ${ei + 1} (${e.label})`, customdata: g.map((f) => S.frames.indexOf(f)),
      marker: { color: EPOCH_COLORS[ei % 8], size: 6, symbol: g.map(sym) },
      text: g.map(hover), hoverinfo: "text",
    };
  });
  Plotly.react("spec", traces, { ...PL, annotations: note, margin: { ...PL.margin, b: 96 },
    legend: { ...PL.legend, y: -0.3, yanchor: "top" },
    xaxis: { ...PL.xaxis, title: "Wavelength (µm)" }, yaxis: { ...PL.yaxis, title: "Flux density (mJy)" } },
    { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
  Plotly.react("lc", [{
    x: fs.map((f) => f.date.replace("T", " ")), y: fs.map((f) => f.flux), mode: "markers", type: "scatter",
    error_y: { array: fs.map((f) => f.ferr), thickness: 1, width: 0, color: "#ffffff33" },
    marker: { color: fs.map((f) => f.wavelength), colorscale: "Turbo", cmin: 0.75, cmax: 5.0, size: 6, symbol: fs.map(sym),
              colorbar: { title: { text: "λ (µm)", side: "right", font: { size: 10 } }, thickness: 8, len: 0.95, outlinewidth: 0, tickfont: { size: 10 } } },
    customdata: fs.map((f) => S.frames.indexOf(f)), text: fs.map(hover), hoverinfo: "text", showlegend: false,
  }], { ...PL, annotations: note,
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
    return `<tr data-i="${i}"><td>${i + 1}</td><td class="mono">${f.date.replace("T", " ")}</td><td>${f.epoch + 1}</td>` +
      `<td><span class="dot" style="--band:${DET_COLORS[f.detector]}"></span>D${f.detector}</td>` +
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
    l.style.setProperty("--band", DET_COLORS[d]);
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
let aladin = null, aladinOverlay = null, hipsUrl = null, hipsMirror = "";

// ---- sky panel background: AllWISE colour, or SPHEREx's own all-sky cube (102 wavelength frames)
const SX_CUBE = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube";
// Frame index = 17*(band-1) + (channel-1), ascending wavelength. 50 and 51 (the dichroic channels) are
// blank by design; frame 0 is stored without a suffix, which Aladin does not request.
const SX_FRAMES = Array.from({ length: 102 }, (_, f) => f).filter((f) => f !== 0 && f !== 50 && f !== 51);
const skyLayers = {};
let skyLayer = "wise", sxTimer = 0;

// Band and approximate wavelength of a cube frame (channels are taken as log-spaced across each band).
function sxFrameInfo(f) {
  const band = Math.floor(f / 17) + 1, [lo, hi] = DET_BANDS[band];
  return { band, wl: lo * Math.pow(hi / lo, ((f % 17) + 0.5) / 17) };
}

// Aladin picks a cube frame by frequency, assuming frames are evenly spaced in frequency from the
// longest wavelength down. SPHEREx's frames are not, so ask for the frequency that lands on file `f`
// (checked against the tiles Aladin then requests).
function showSxFrame(f, tries = 0) {
  const h = skyLayers.sx;
  if (!h) return;
  if (!h.cubeDepth) { if (tries < 30) setTimeout(() => showSxFrame(f, tries + 1), 300); return; }  // properties still loading
  const C = 299792458, D = h.cubeDepth, fmin = C / h.emMax, fmax = C / h.emMin;
  const freq = fmin + ((f + 0.5) / D) * (fmax - fmin);
  h.setSliceNumber(((C / freq - h.emMin) / (h.emMax - h.emMin)) * D);
}

function setSkyLayer(kind) {
  skyLayer = kind === "sx" ? "sx" : "wise";
  syncSkyLayerUI();
  if (!aladin) return;  // applied when the panel is created
  try {
    if (skyLayer === "sx") {
      skyLayers.sx ??= A.HiPS(SX_CUBE, { name: "SPHEREx DR1 all-sky cube" });
      aladin.setBaseImageLayer(skyLayers.sx);
      showSxFrame(SX_FRAMES[+$("#sxframe").value]);
    } else if (hipsUrl) {
      skyLayers.wise ??= A.HiPS(hipsUrl, { name: "AllWISE colour" });
      aladin.setBaseImageLayer(skyLayers.wise);
    }
  } catch (e) { $("#skyhint").textContent = `Could not switch the sky image: ${e}`; }
  updateURL();
}

function syncSkyLayerUI() {
  document.querySelectorAll("#skylayer button").forEach((b) => b.classList.toggle("on", b.dataset.v === skyLayer));
  $("#sxwave").classList.toggle("hidden", skyLayer !== "sx");
  $("#hipssrc").textContent = skyLayer === "sx" ? "SPHEREx all-sky mosaic · IRSA" : `AllWISE colour${hipsMirror ? " · " + hipsMirror : ""}`;
  const { band, wl } = sxFrameInfo(SX_FRAMES[+$("#sxframe").value]);
  $("#sxlabel").textContent = `≈ ${wl.toFixed(2)} µm · D${band}`;
  $("#sxdot").style.setProperty("--band", DET_COLORS[band]);
}
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
      if (r.ok && (await r.text()).includes("hips_")) { hipsUrl = url; hipsMirror = name; syncSkyLayerUI(); return url; }
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
      // The panel is for looking around only: drag, zoom, full screen. Aladin's own menus (layers,
      // settings, grid, coordinate frame, context menu, catalogue and drawing tools) stay off; the
      // image is chosen with this page's AllWISE / SPHEREx switch instead.
      aladin = A.aladin("#aladin", { survey, fov: (S.fov / 60) * 3, target: `${ra} ${dec}`,
        showZoomControl: true, showFullscreenControl: true, realFullscreen: false, showFov: true, showReticle: true,
        showLayersControl: false, showSettingsControl: false, showCooGridControl: false, showFrame: false,
        showCooLocation: false, showStatusBar: false, showContextMenu: false, showGotoControl: false,
        showProjectionControl: false, showSimbadPointerControl: false, showShareControl: false,
        showColorPickerControl: false });  // showCatalog stays on: it is what draws the selected-object label
      // showContextMenu: false is not honoured by this Aladin build, so stop right-clicks before they
      // reach it (its menu offers drawing, selecting and loading files, which this panel does not need).
      for (const type of ["contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup"]) {
        $("#aladin").addEventListener(type, (e) => {
          if (type !== "contextmenu" && e.button !== 2) return;
          e.stopPropagation();
          if (type === "contextmenu") e.preventDefault();
        }, true);
      }
      aladinOverlay = A.graphicOverlay({ color: "#ff9e3d", lineWidth: 2 });
      aladin.addOverlay(aladinOverlay);
      // full-screen is a fixed overlay over the page: stop the page scrolling behind it
      aladin.on("fullScreenToggled", (full) => document.body.classList.toggle("sky-full", full));
      // Field picker: a dashed box fixed at the centre of the view shows what "Load this field" would fetch.
      skyBox = document.createElement("div");
      skyBox.id = "skybox";
      $("#aladin").appendChild(skyBox);
      // Green outline: the part of the loaded field the player is showing (when it is zoomed in).
      skyViewOverlay = A.graphicOverlay({ color: "#7bd88f", lineWidth: 2 });
      aladin.addOverlay(skyViewOverlay);
      ignoreSkyUntil = performance.now() + 800;
      aladin.on("positionChanged", onSkyMoved);
      aladin.on("zoomChanged", syncSkyPick);
      new ResizeObserver(syncSkyPick).observe($("#aladin"));
      if (skyLayer === "sx") setSkyLayer("sx");  // chosen before the panel existed (e.g. from the URL)
    } else {
      if (!S.keepSkyView) { ignoreSkyUntil = performance.now() + 800; aladin.gotoRaDec(ra, dec); aladin.setFoV((S.fov / 60) * 3); }
      aladinOverlay.removeAll();
    }
    S.keepSkyView = false;
    if (S.data.moving) drawSkyTrack();  // the object's path replaces the fixed field outline
    else aladinOverlay.add(A.polygon(corners));
    syncSkyPick();
  }).catch((e) => { $("#aladin").innerHTML = `<p class="hint">Sky context unavailable: ${e}</p>`; });
}
// Keep the picker box and the "Load this field" button in step with where the sky panel is looking.
// The solid orange outline is the field already loaded; the dashed box is the field under the view centre.
let skyBox = null, skyViewOverlay = null, lastViewKey = "", ignoreSkyUntil = 0;

// Player -> sky panel: outline what the player is showing. Runs on every render, so it only
// touches Aladin when the visible window actually changed.
function syncSkyView() {
  if (!aladin || !skyViewOverlay || !S.data) return;
  const v = viewRect();
  const key = S.data.moving || S.zoom <= 1.01 ? "" : `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.w.toFixed(2)},${S.data.center.ra},${S.data.center.dec}`;
  if (key === lastViewKey) return;
  lastViewKey = key;
  skyViewOverlay.removeAll();
  if (!key) return;
  skyViewOverlay.add(A.polygon([[v.x, v.y], [v.x + v.w, v.y], [v.x + v.w, v.y + v.w], [v.x, v.y + v.w]].map(([ex, ey]) => pixToSky(ex - 0.5, ey - 0.5))));
}

// Sky panel -> player: dragging the sky while the player is zoomed in moves the player's view to the
// same place, as long as it is inside the loaded field. Moves made by this page itself are ignored.
function onSkyMoved(ev) {
  syncSkyPick();
  if (performance.now() < ignoreSkyUntil || !S.data || S.data.moving || S.zoom <= 1.01) return;
  let ra, dec;
  try { [ra, dec] = ev && ev.ra != null ? [ev.ra, ev.dec] : aladin.getRaDec(); } catch (_) { return; }
  const [c, r] = skyToPix(ra, dec), n = S.data.npix;
  if (c < -0.5 || r < -0.5 || c > n - 0.5 || r > n - 0.5) return;  // outside the loaded field: that is what "Load this field" is for
  S.cx = c + 0.5; S.cy = r + 0.5;
  const cl = viewRect(); S.cx = cl.x + cl.w / 2; S.cy = cl.y + cl.w / 2;
  render();
}

function syncSkyPick() {
  const btn = $("#skyload");
  if (!aladin || !skyBox || !S.data) return;
  let ra, dec, fovDeg;
  try { [ra, dec] = aladin.getRaDec(); fovDeg = aladin.getFov()[0]; } catch (_) { return; }
  if (!(fovDeg > 0) || ra == null) return;
  const fieldArcmin = +$("#fov").value;
  const side = ((fieldArcmin / 60) / fovDeg) * $("#aladin").clientWidth;
  const c = S.data.center, dra = (((ra - c.ra + 540) % 360) - 180) * Math.cos(c.dec * d2r);
  const offArcmin = Math.hypot(dra, dec - c.dec) * 60;
  // worth loading once the view centre has left the middle of the loaded field (always, when following a moving object)
  const moved = S.data.moving || offArcmin > 0.15 * S.data.fov_arcmin;
  S.skyPick = { ra, dec };
  skyBox.style.display = moved ? "block" : "none";
  skyBox.style.width = skyBox.style.height = `${Math.max(6, side)}px`;
  btn.disabled = !moved;
  $("#skyhint").textContent = moved
    ? `${fieldArcmin}′ field at ${fmtRA(ra)} ${fmtDec(dec)}${S.data.moving ? "" : ` · ${offArcmin < 60 ? offArcmin.toFixed(1) + "′" : (offArcmin / 60).toFixed(1) + "°"} from the loaded one`}`
    : S.zoom > 1.01 ? "Green outline: what the player shows. Drag the sky to move it, or further to pick another field"
    : "Drag the sky to pick another field";
}
function loadSkyPick() {
  if (!S.skyPick) return;
  const { ra, dec } = S.skyPick, q = `${ra.toFixed(5)} ${dec.toFixed(5)}`;
  $("#q").value = q;
  load(q, +$("#fov").value, { ra, dec, keepSkyView: true });
}

// Solar-system object: draw where it was in each SPHEREx visit and frame the whole path.
function drawSkyTrack() {
  if (!aladin || !aladinOverlay || !S.data?.moving || !S.frames.length) return;
  aladinOverlay.removeAll();
  const sep = (a, b) => Math.hypot((a.ra_obj - b.ra_obj) * Math.cos(a.dec_obj * d2r), a.dec_obj - b.dec_obj);
  let far = 0;
  const mid = S.frames[S.frames.length >> 1];
  S.data.epochs.forEach((_, ei) => {
    const fs = S.frames.filter((f) => f.epoch === ei);
    if (!fs.length) return;
    for (const f of fs) far = Math.max(far, sep(f, mid));
    try {
      if (fs.length > 1) aladinOverlay.add(A.polyline(fs.map((f) => [f.ra_obj, f.dec_obj]), { color: EPOCH_COLORS[ei % 8], lineWidth: 3 }));
      aladinOverlay.add(A.circle(fs[0].ra_obj, fs[0].dec_obj, Math.max(0.01, far / 60), { color: EPOCH_COLORS[ei % 8] }));
    } catch (_) { /* overlay shapes are a nicety */ }
  });
  ignoreSkyUntil = performance.now() + 800;
  aladin.gotoRaDec(mid.ra_obj, mid.dec_obj);
  aladin.setFoV(Math.min(170, Math.max(0.5, far * 2.4)));
}

// Drag (or arrow keys on) the grip under the panel to change its height. Aladin watches its div
// with a ResizeObserver, so it redraws by itself. CSS `resize` is not used: it needs overflow:hidden,
// which would clip Aladin's menus.
function wireSkyGrip() {
  const grip = $("#skygrip"), box = $("#aladin");
  if (!grip || !box) return;  // e.g. a stale cached index.html without the grip: the viewer must still start
  const setH = (h) => (box.style.height = `${Math.round(Math.min(Math.max(h, 220), innerHeight * 0.9))}px`);
  let start = null;
  grip.addEventListener("pointerdown", (e) => {
    start = { y: e.clientY, h: box.offsetHeight }; grip.setPointerCapture(e.pointerId); grip.classList.add("drag");
  });
  grip.addEventListener("pointermove", (e) => { if (start) setH(start.h + e.clientY - start.y); });
  const end = () => { start = null; grip.classList.remove("drag"); };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault(); e.stopPropagation();
    setH(box.offsetHeight + (e.key === "ArrowDown" ? 40 : -40));
  });
}

// ------------------------------------------------------------------ URL state
function updateURL() {
  const p = new URLSearchParams();
  if (S.target?.moving) p.set("moving", S.query);
  else if (S.target?.name && S.query && !/^[\d\s.+:hmsd°'"−-]+$/i.test(S.query)) p.set("target", S.query);
  else if (S.target) { p.set("ra", S.target.ra.toFixed(6)); p.set("dec", S.target.dec.toFixed(6)); }
  p.set("fov", S.fov);
  if (S.mode !== "epoch") p.set("mode", S.mode);
  if (S.dets.size < 6) p.set("det", [...S.dets].sort().join(""));
  if (skyLayer === "sx") p.set("sky", `sx${SX_FRAMES[+$("#sxframe").value]}`);
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
  for (const p of PRESETS) {
    const b = document.createElement("button"); b.type = "button";
    b.innerHTML = `${p.label}<span>${p.note}</span>`;
    if (p.moving) b.classList.add("moving");
    b.onclick = () => { $("#q").value = p.q; load(p.q, +$("#fov").value, { moving: !!p.moving }); };
    $(p.moving ? "#presets-moving" : "#presets-sky").appendChild(b);
  }
  $("#kind").onchange = syncKind;
  syncKind();
  $("#search").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#q").value.trim();
    if (q) load(q, +$("#fov").value, { moving: $("#kind").value === "moving" });
  });
  document.querySelectorAll("#mode button").forEach((b) => (b.onclick = () => setMode(b.dataset.v)));
  $("#play").onclick = () => { S.playing = !S.playing; $("#play").textContent = S.playing ? "❚❚" : "▶"; };
  $("#slider").oninput = (e) => { S.idx = +e.target.value; S.playing = false; $("#play").textContent = "▶"; render(); };
  $("#speed").oninput = (e) => (S.speed = +e.target.value);
  $("#contrast").oninput = () => { computeLimits(); render(); };
  for (const id of ["#stretch", "#invert", "#ov-gaia", "#ov-names", "#ov-target", "#ov-ap"]) $(id).onchange = render;
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
    const v = S.seq[S.idx].arr[r * n + c];
    let wherePix;
    if (S.data.moving) wherePix = `${offsetText(c, r)} from object`;
    else {
      const [ra, dec] = pixToSky(c, r); wherePix = `${fmtRA(ra)} ${fmtDec(dec)}`;
      // name tag for the catalogue object under the pointer
      const o = nearestObject(ex - 0.5, ey - 0.5, S.seq[S.idx].decyear, 1.6);
      if (o !== S.hoverObj) { S.hoverObj = o; view.style.cursor = o ? "pointer" : ""; render(); }
    }
    $("#hover").textContent = `${wherePix} · ${v === v ? v.toFixed(3) : "no data"} MJy/sr`;
  });
  view.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const wasDrag = drag.moved; drag = null; view.style.cursor = "";
    if (wasDrag || !S.data) return;
    const { col, row } = evToPix(e);
    if (S.data.moving) S.phot = { mode: "pixel", col, row };
    else S.phot = pickSource(col, row, S.seq[S.idx]);
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
  view.addEventListener("mouseleave", () => {
    $("#hover").textContent = "";
    if (S.hoverObj) { S.hoverObj = null; view.style.cursor = ""; render(); }
  });
  $("#zoomin").onclick = () => S.data && zoomAt(1.5, S.cx, S.cy);
  $("#zoomout").onclick = () => S.data && zoomAt(1 / 1.5, S.cx, S.cy);
  $("#zoomreset").onclick = () => { if (S.data) { resetZoom(); render(); } };
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" && e.target.type !== "range" && e.target.type !== "checkbox") return;
    if (e.target.closest?.("#aladin")) return; // keys typed in Aladin's own inputs and menus
    if (!S.seq.length) return;
    if (e.key === " ") { e.preventDefault(); $("#play").click(); }
    else if (e.key === "ArrowRight") { S.playing = false; S.idx = (S.idx + 1) % S.seq.length; render(); }
    else if (e.key === "ArrowLeft") { S.playing = false; S.idx = (S.idx - 1 + S.seq.length) % S.seq.length; render(); }
  });
  wireSkyGrip();
  $("#skyload").onclick = loadSkyPick;
  document.querySelectorAll("#skylayer button").forEach((b) => (b.onclick = () => setSkyLayer(b.dataset.v)));
  $("#sxframe").oninput = () => {
    syncSkyLayerUI();  // label follows the slider at once; the tiles are fetched when it settles
    clearTimeout(sxTimer);
    sxTimer = setTimeout(() => { showSxFrame(SX_FRAMES[+$("#sxframe").value]); updateURL(); }, 150);
  };
  $("#fov").addEventListener("change", syncSkyPick);  // the picker box shows the size that would be loaded
  $("#copylink").onclick =() => copy(location.href.replace(/[?&]embed=1/, ""), "#copylink");
  $("#copyembed").onclick = () => {
    const u = new URL(location.href); u.searchParams.set("embed", "1");
    copy(`<iframe src="${u}" width="560" height="760" style="border:0" title="SPHEREx Motion Viewer"></iframe>`, "#copyembed");
  };
  $("#ftable tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr"); if (!tr || e.target.tagName === "A") return;
    jumpToFrame(S.frames[+tr.dataset.i]);
  });
}
// The search box means different things for the two kinds of target.
function syncKind() {
  const moving = $("#kind").value === "moving";
  $("#q").placeholder = moving ? "Asteroid or comet: name, designation or NAIF id (e.g. Vesta, C/2025 N1, 20000433)"
                               : "Object name or RA Dec (e.g. 08h55m10.8s -07d14m42s)";
}
function copy(text, btn) {
  navigator.clipboard?.writeText(text).then(() => { const b = $(btn), t = b.textContent; b.textContent = "Copied"; setTimeout(() => (b.textContent = t), 1200); });
}

// ------------------------------------------------------------------ boot
wire();
requestAnimationFrame(tick);
(() => {
  const p = new URLSearchParams(location.search);
  const sky = /^sx(\d+)?$/.exec(p.get("sky") || "");
  if (sky) {
    const i = SX_FRAMES.indexOf(+sky[1]);
    if (i >= 0) $("#sxframe").value = i;
    skyLayer = "sx";
  }
  syncSkyLayerUI();
  S.embed = p.get("embed") === "1";
  document.body.classList.toggle("embed", S.embed);
  if (p.get("mode")) { S.mode = p.get("mode"); document.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("on", b.dataset.v === S.mode)); }
  if (p.get("det")) S.dets = new Set(p.get("det").split("").map(Number).filter((d) => d >= 1 && d <= 6));
  const fov = +(p.get("fov") || 5);
  const fsel = $("#fov");
  if (![...fsel.options].some((o) => +o.value === fov)) fsel.add(new Option(`${fov}′`, fov));
  fsel.value = String(fov);
  if (p.get("moving")) { $("#q").value = p.get("moving"); load(p.get("moving"), fov, { moving: true }); }
  else if (p.get("target")) { $("#q").value = p.get("target"); load(p.get("target"), fov); }
  else if (p.get("ra") && p.get("dec")) {
    const ra = +p.get("ra"), dec = +p.get("dec");
    $("#q").value = `${ra} ${dec}`;
    load(`${ra} ${dec}`, fov, { ra, dec });
  }
})();
