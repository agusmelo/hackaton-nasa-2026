# SPHEREx Motion Viewer

Prototype for the NASA Space Apps 2026 challenge **"Planet X and SPHEREx"**: type a sky position or object name, and blink every NASA SPHEREx near-infrared exposure of that patch across survey epochs to spot things that move or change.

## Run

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows; use .venv/bin/pip elsewhere
.venv/Scripts/python -m uvicorn app:app --port 8765
```

Open <http://localhost:8765/?target=WISE%20J085510.83-071442.5>.

> On Windows, keep the virtualenv on a short path: astropy's compiled modules fail to load ("filename or extension is too long") when the venv sits deep in the filesystem.

Optional: `python warm_cache.py` pre-fetches the five challenge targets so a live demo loads instantly.

## What it does

| Challenge ask | How |
|---|---|
| Enter RA/Dec, see a time series like a little video | Search box takes names (CDS Sesame) or coordinates in any common format; frames play as an animation |
| Easy to update with new data releases | Images are queried live from IRSA SIA; collections are a list (`SPHEREX_COLLECTIONS` env var, default `spherex_dr1,spherex_qr3`) |
| Use the 102 bands / six detectors | Per-detector toggles (D1–D6, 0.75–5.0 µm); epoch stacks are medians of the selected detectors only. *Colour* mode maps 0.75–1.6 µm to blue, 1.6–3.8 µm to green and 3.8–5 µm to red, each scaled by its own noise, so cold objects stand out red |
| Generate spectra on the fly | Aperture photometry on every exposure at its own LVF wavelength → spectrum (colour = epoch) and light curve (colour = wavelength) |
| Add/subtract epochs | *Difference* mode: each epoch minus the median of the other epochs taken with the same detector orientation (SPHEREx flips ~180° between passes six months apart, which turns the PSF around). The stretch is set from the background noise, so a bright star's residual does not flatten the rest of the field. Movers appear as black/white pairs |
| Choose the field of view | 2.5′ to 12′ (up to 15′ via URL); scroll to zoom up to 12×, drag to pan, double-click to reset |
| Overlay Gaia / WISE | Gaia DR3 sources propagated with proper motion to each frame's epoch; Aladin Lite AllWISE colour context |
| Coordinates in the URL / embeddable | `?target=R%20Dra`, `?ra=…&dec=…&fov=…&mode=diff&det=56`, `&embed=1` for an iframe |
| Metadata such as contamination flags | Per-exposure table with SPHEREx FLAGS bits near the target (OVERFLOW, PERSIST, GHOST, STREAK…), plus a link to each source FITS |

## How it works

* **Search**: IRSA SIA (`spherex_dr1`, `spherex_qr3`) returns every Level-2 spectral image covering the position.
* **Reading pixels**: IRSA's cutout service ships the whole ePSF table with every cutout (~4 MB, ~10 s each). `fitsrange.py` instead uses HTTP range requests on the full MEF: it reads the headers, the needed rows of the IMAGE HDU, and the needed RICE-compressed rows of the FLAGS HDU, decoding them with astropy's Rice codec. For a 5′ field that is about 0.5 MB per exposure (whole detector rows are read). The wavelength comes from the `WCS-WAVE` lookup table at the end of the file. Results match the cutout service pixel for pixel.
* **Reprojection**: every exposure is bilinearly resampled (with the SIP distortion from its own WCS) onto one north-up TAN grid at the native 6.15″ scale, centred where the target is in 2026.0 (proper motion applied). Hard-bad pixels are masked and the per-frame median is subtracted to remove zodiacal light.
* **Client**: frames arrive as float32 arrays. Stacking, differencing, stretch, overlays and photometry all run in the browser, so changes are instant.
* **Cache**: the processed frames are cached on disk (`cache/`), so a field is fetched from IRSA only once.

## Things learned on the test targets

* **WISE 0855**: invisible below 3 µm but detected in D5+D6 (3.8–5 µm). The peak pixel moves from column 23 to 24, 24 and then 25 across the four epochs (May 2025 to May 2026), matching the predicted 8.1″/yr motion (1.3 px/yr). A static background star one pixel away blends with it at short wavelengths, which is why the short-λ "spectrum" shows about 1 mJy.
* **Barnard's Star**: 10.4″/yr (1.7 px/yr). Difference mode shows a clean north-south dipole across 7 epochs. The star saturates SPHEREx, so every exposure is flagged and its core is masked.
* **Epsilon Indi B**: the on-the-fly spectrum from 356 exposures is a textbook T dwarf: H₂O-bounded peaks at 1.25, 1.6 and 2.1 µm, deep CH₄ absorption at 3.3 µm, a 4 µm peak, and CO absorption near 4.6 µm.
* **R Draconis** (Mira): saturated in all 539 exposures (OVERFLOW plus BLOOM). Photometry therefore falls back to the unsaturated PSF wings (one ring per target, 6–10 px here). In the 1.5–1.8 µm band, brightness varies about 2× across 15 epochs, with maxima around May 2025 and late Dec 2025 to Jan 2026, consistent with its ~245-day period.
* **RW Aurigae**: also saturated (wing photometry). Flat at 1–2.4 µm but fading by about 45% at 4–4.5 µm from Sep 2025 to Sep 2026, a change in its infrared excess.
* **Epochs, not individual exposures**: SPHEREx's linear-variable filter means a source is seen at a different wavelength in every exposure. Blinking raw exposures mixes colour with variability; blinking per-epoch stacks of the *same* detectors does not.

## Limitations / next steps

* No aperture correction, so fluxes are relative. Wing photometry (for saturated stars) is relative and its PSF fraction changes with wavelength, so compare it at similar wavelengths only. The ePSF extension could be used for PSF photometry and calibrated wing fits.
* Coordinates typed without a name get no proper-motion correction. WISE 0855's catalogue coordinates (epoch ~2010) are about 2′ from where it is in 2026, still inside a 5′ field.
* The Aladin Lite context image needs internet access. The viewer tries the AllWISE mirrors in order (IRSA, ESA, CDS) and uses the first that answers, because the CDS tile server can be down.
* The first visit to a field reads ~250–350 exposures (~1–2 min in total). The viewer opens after the IRSA search (~8 s) and images, stacks and the spectrum fill in as exposures arrive. A production version would precompute popular fields or use the SPHEREx HiPS cubes.
* Difference images still leave residuals on the brightest field stars, where saturated cores are masked differently in each epoch. Positions themselves agree with Gaia to about 0.05 px between epochs.
* Bilinear resampling slightly smooths the images. Drizzle or ePSF-aware resampling would sharpen motion detection.
* Possible additions: a moving-object (asteroid) mode that compares exposures within the same day, and clicking a frame to open it in an external FITS viewer.

## License

The code in this repository is released under the [MIT License](LICENSE).

Two third-party libraries are bundled unmodified in `static/vendor/` and keep their own licenses, which the MIT license above does not cover:

| File | Library | License |
|---|---|---|
| `static/vendor/plotly.min.js` | plotly.js 2.35.2 | MIT |
| `static/vendor/aladin.js` | Aladin Lite 3.8.2 (CDS, Strasbourg) | GPL-3.0 |

Data: NASA SPHEREx via IRSA, Gaia DR3 (ESA), object names via CDS Sesame.
