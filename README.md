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
| Find comets and asteroids, not only stars | *Asteroid / comet* search: type a solar-system object (`?moving=3I/ATLAS`). IRSA's Moving Object Search Tool (MOST) lists every SPHEREx exposure that caught it and where it was; each frame is centred on that position, so the object holds still, the stars drift past and the epoch stack removes them. Spectrum and light curve work the same way |
| Easy to update with new data releases | Nothing to edit when a release comes out. The server reads the list of release folders in NASA's public SPHEREx bucket (`dr1/`, `qr3/`, …), uses every Data Release plus the newest Quick Release, wide and deep surveys, and queries those collections live at IRSA. The page footer says which releases were found and when. `SPHEREX_COLLECTIONS` overrides the list |
| Use the 102 bands / six detectors | Per-detector toggles (D1–D6, 0.75–5.0 µm); epoch stacks are medians of the selected detectors only. *Bands* mode adds together everything each detector took and plays the six deep images from 0.75 to 5 µm. *Colour* mode maps 0.75–1.6 µm to blue, 1.6–3.8 µm to green and 3.8–5 µm to red, each scaled by its own noise, so cold objects stand out red |
| Generate spectra on the fly | Aperture photometry on every exposure at its own LVF wavelength → spectrum (colour = epoch) and light curve (colour = wavelength) |
| Add/subtract epochs | *Sum* mode adds every epoch into one deeper image (exposure-weighted mean of the epoch stacks). *Difference* mode: each epoch minus the median of the other epochs taken with the same detector orientation (SPHEREx flips ~180° between passes six months apart, which turns the PSF around). The stretch is set from the background noise, so a bright star's residual does not flatten the rest of the field. Movers appear as black/white pairs |
| Choose the field of view | 2.5′ to 15′ (a 15′ field transfers about 9 times as much as a 5′ one); scroll to zoom up to 12×, drag to pan, double-click to reset |
| Explore beyond the first target | Drag the sky in the *Sky context* panel: a dashed box at its centre shows the field that would be fetched, the solid orange outline is the field already loaded. *Load this field* sends that position to the player; the search it replaces is cancelled on the server straight away |
| Follow anything you click | Click a source in the player. If a Gaia DR3 star is within 1.5 px, the measurement circle follows it with Gaia's proper motion. Otherwise the motion is measured from the images: the source is located in every epoch stack of the selected detectors and a line is fitted to position against time; the circle follows that fit and the panel reports the value with its error |
| Know what you are looking at | Every catalogue object in the field can be identified. Hovering a mark shows its name, brightness and motion; objects SIMBAD has a name for, and fast-moving stars, are labelled on the image. Selecting one fills a card with what the catalogues know (type, spectral type, brightness, colour, temperature, distance, proper motion, radial velocity) and labels the same object in the sky panel. Sources in no catalogue get a card with the motion measured here |
| Player and sky panel move together | With the player zoomed in, the sky panel outlines in green what the player shows; dragging the sky inside the loaded field moves the player's view to the same place |
| See the sky in SPHEREx itself | The *Sky context* panel can switch from the AllWISE colour image to SPHEREx's own DR1 all-sky mosaic (a HiPS cube on IRSA) and step through 99 of its 102 wavelength frames with a slider (`&sky=sx91`). It is a time average at 13″ per pixel, so it gives context, not motion |
| Overlay Gaia / WISE | Gaia DR3 sources propagated with proper motion to each frame's epoch. WISE sources from CatWISE2020 (IRSA): their W1/W2 magnitudes are added to the Gaia and SIMBAD objects they match, and a *WISE sources not in Gaia* layer draws the rest as diamonds, red when bright and red in W1−W2 (the colour of a cool brown dwarf or a dusty galaxy). AllWISE colour image in the sky panel |
| Coordinates in the URL / embeddable | `?target=R%20Dra`, `?ra=…&dec=…&fov=…&mode=diff&det=56`, `?moving=Ceres`; `&embed=1` leaves only the player, its controls and an "Open full viewer" link, for an iframe (560 × 920 suggested) |
| Metadata such as contamination flags | Per-exposure table with SPHEREx FLAGS bits near the target (OVERFLOW, PERSIST, GHOST, STREAK…), plus a link to each source FITS |

## How it works

* **Search**: IRSA SIA returns every Level-2 spectral image covering the position, one query per collection run side by side. The collections come from `releases()` in `spherex.py` (see the table above); IRSA's SIA cannot be probed for them, because it answers an unknown collection the same way as an empty one.
* **When IRSA's search is down**: it has outages (HTTP 502) and slow spells. `search_images_ex()` uses the image list saved for a position if it is less than a day old, without asking IRSA. Otherwise it asks; if only some collections answer, it keeps going with those and says which are missing; if none answers, it uses the saved list whatever its age and says from when. Only a position that was never loaded cannot be shown, and the error says so. The pixels themselves come from the AWS mirror and the local cache, so a known position keeps working through an IRSA outage.
* **WISE sources**: `wise_sources()` asks IRSA's catalogue service for CatWISE2020 around the field. Sources fainter than W1 = 17 and W2 = 16 are dropped as noise at SPHEREx depth, and a CatWISE proper motion is only used for bright sources (W1 < 15 or W2 < 14.5). Near a fast-moving object the catalogue can hold several entries for it from different dates.
* **Reading pixels**: IRSA's cutout service ships the whole ePSF table with every cutout (~4 MB, ~10 s each). `fitsrange.py` instead uses HTTP range requests on the full MEF: it reads the headers, the needed rows of the IMAGE HDU, and the needed RICE-compressed rows of the FLAGS HDU, decoding them with astropy's Rice codec. For a 5′ field that is about 0.5 MB per exposure (whole detector rows are read). The wavelength comes from the `WCS-WAVE` lookup table at the end of the file. Results match the cutout service pixel for pixel.
* **Where the bytes come from**: the same files are mirrored in NASA's public S3 bucket (`nasa-irsa-spherex`). Range reads go there first and fall back to IRSA. Measured on 60 uncached exposures: IRSA with 10 readers 2.3 frames/s, S3 with 10 readers 4.0, S3 with 24 readers 6.9, identical pixels and no failures. Set `SPHEREX_SOURCE=irsa` to read from IRSA only.
* **Solar-system objects**: `most_search()` in `spherex.py` calls MOST (`catalog=spherex`), which propagates the JPL Horizons orbit to every exposure time. One query takes about a minute and is cached for a week. MOST wants the bare Horizons name, so "433 Eros" is retried as "Eros" and "3I/ATLAS" as "3I"; an ambiguous name returns the list of NAIF ids to choose from.
* **Catalogues**: Gaia DR3 comes from STScI/MAST's TAP service (the archive the challenge lists), with ESA's archive as fallback; the query now also asks for colour, temperature, radial velocity and the variability flag. Names and object types come from a SIMBAD cone search on the Harvard mirror (`/api/simbad`), with CDS as fallback. SIMBAD rows carry the Gaia DR3 id, which is how the two are joined; SIMBAD objects that Gaia does not have (galaxies, brown dwarfs such as WISE 0855) are kept as objects of their own and propagated from J2000 with SIMBAD's proper motion.
* **Path of a solar-system object**: drawn by `paintSkyTrack()` on a canvas of our own laid over Aladin (positions go through `aladin.world2pix`), redrawn every animation frame so it stays glued to the sky while Aladin pans or zooms. One thin glowing line per visit with its month and an arrow head for the direction; the visit on screen is in the accent colour and a bright dot marks where the object is in the frame the player shows. Aladin's centre reticle is hidden in this mode because it is not the object.
* **Sky panel projection**: stereographic (`projection: "STG"`), which shows the sky as seen from inside the sphere, like a planetarium. Aladin's default orthographic projection draws a wide field as a globe seen from outside. The mouse wheel is handled by this page, not by Aladin: it only changes the field of view about the centre of the panel, between 0.03° and 140°. Past that, Aladin would fold the whole sphere (360° × 180°) into the panel and the inside view is lost; its + / − buttons are held to the same limits.
* **Sky panel controls**: Aladin Lite runs with only its navigation left on (drag, zoom buttons, full screen, centre reticle, field-size readout). Its layer, settings, grid, coordinate-frame and catalogue controls are switched off through its options. Its right-click menu (drawing, selections, loading files) ignores `showContextMenu: false` in this build, so right-clicks are stopped before they reach Aladin and the menu is also hidden in CSS.
* **SPHEREx mosaic in the sky panel**: Aladin Lite picks a cube frame by frequency and assumes the frames are evenly spaced in frequency, starting from the longest wavelength. SPHEREx's frames are ordered by band and channel instead, so `showSxFrame()` in `static/app.js` asks for the frequency that lands on the wanted file; this was checked against the tiles Aladin then requested (frames 1, 17, 22, 40, 49, 84, 91, 101). Frames 50 and 51 are blank by design and frame 0 is stored under a name Aladin does not request, so those three are skipped. The wavelength shown next to the slider is approximate: channels are taken as log-spaced across each band.
* **Reprojection**: every exposure is bilinearly resampled (with the SIP distortion from its own WCS) onto one north-up TAN grid at the native 6.15″ scale, centred where the target is in 2026.0 (proper motion applied). Hard-bad pixels are masked and the per-frame median is subtracted to remove zodiacal light.
* **Client**: frames arrive as float32 arrays. Stacking, differencing, stretch, overlays and photometry all run in the browser, so changes are instant.
* **Cache**: the processed frames are cached on disk (`cache/`), so a field is fetched from IRSA only once.

## Things learned on the test targets

* **WISE 0855**: invisible below 3 µm but detected in D5+D6 (3.8–5 µm). The peak pixel moves from column 23 to 24, 24 and then 25 across the four epochs (May 2025 to May 2026), matching the predicted 8.1″/yr motion (1.3 px/yr). A static background star one pixel away blends with it at short wavelengths, which is why the short-λ "spectrum" shows about 1 mJy.
* **Barnard's Star**: 10.4″/yr (1.7 px/yr). Difference mode shows a clean north-south dipole across 7 epochs. The star saturates SPHEREx, so every exposure is flagged and its core is masked.
* **Epsilon Indi B**: the on-the-fly spectrum from 356 exposures is a textbook T dwarf: H₂O-bounded peaks at 1.25, 1.6 and 2.1 µm, deep CH₄ absorption at 3.3 µm, a 4 µm peak, and CO absorption near 4.6 µm.
* **R Draconis** (Mira): saturated in all 539 exposures (OVERFLOW plus BLOOM). Photometry therefore falls back to the unsaturated PSF wings (one ring per target, 6–10 px here). In the 1.5–1.8 µm band, brightness varies about 2× across 15 epochs, with maxima around May 2025 and late Dec 2025 to Jan 2026, consistent with its ~245-day period.
* **RW Aurigae**: also saturated (wing photometry). Flat at 1–2.4 µm but fading by about 45% at 4–4.5 µm from Sep 2025 to Sep 2026, a change in its infrared excess.
* **Comet 3I/ATLAS** (interstellar, `?moving=3I/ATLAS`): 364 exposures in three visits. It sits on the centre pixel in every epoch stack, at 53, 139 and 7 times the background noise (Aug 2025, Dec 2025, Mar 2026). The spectrum has a strong emission line at 4.2–4.32 µm, where CO₂ gas emits: 6.9 mJy against about 0.2 mJy at neighbouring wavelengths in August, and 226 mJy against 5–10 mJy in December.
* **Ceres** (`?moving=Ceres`): 326 exposures in four visits; saturated in 279 of them, so it is measured from the PSF wings. The spectrum rises towards 5 µm, as expected from thermal emission.
* **Motion measured from the images alone** (click-to-follow, checked against catalogue values): Epsilon Indi B gives 5.4 ± 0.4″/yr toward the south-east against 4.68″/yr in the catalogue (7 epochs, 1.4 yr). WISE 0855, which is not in Gaia, gives 6.0 ± 0.8″/yr toward the west in D5+D6 against 8.15″/yr (4 epochs, 1.0 yr); the static star one pixel away pulls its centroid, so the value comes out low. The direction is right in both cases; treat the size as good to roughly 20–30%.
* **Epochs, not individual exposures**: SPHEREx's linear-variable filter means a source is seen at a different wavelength in every exposure. Blinking raw exposures mixes colour with variability; blinking per-epoch stacks of the *same* detectors does not.

## Limitations / next steps

* No aperture correction, so fluxes are relative. Wing photometry (for saturated stars) is relative and its PSF fraction changes with wavelength, so compare it at similar wavelengths only. The ePSF extension could be used for PSF photometry and calibrated wing fits.
* Coordinates typed without a name get no proper-motion correction. WISE 0855's catalogue coordinates (epoch ~2010) are about 2′ from where it is in 2026, still inside a 5′ field.
* The Aladin Lite context image needs internet access. The viewer tries the AllWISE mirrors in order (IRSA, ESA, CDS) and uses the first that answers, because the CDS tile server can be down.
* The first visit to a field reads ~250–350 exposures (~1–2 min in total). The viewer opens after the IRSA search (~8 s) and images, stacks and the spectrum fill in as exposures arrive. A production version would precompute popular fields or use the SPHEREx HiPS cubes.
* Difference images still leave residuals on the brightest field stars, where saturated cores are masked differently in each epoch. Positions themselves agree with Gaia to about 0.05 px between epochs.
* Bilinear resampling slightly smooths the images. Drizzle or ePSF-aware resampling would sharpen motion detection.
* Solar-system mode: no Gaia overlay (the background differs in every frame), and a star crossing the aperture contaminates that single exposure's point in the spectrum. The object's brightness also changes with its distance, which the light curve does not correct for. Finding *unknown* movers (comparing exposures within the same day without a known orbit) is not implemented.
* Possible addition: clicking a frame to open it in an external FITS viewer.

## License

The code in this repository is released under the [MIT License](LICENSE).

Two third-party libraries are bundled in `static/vendor/` and keep their own licenses, which the MIT license above does not cover. plotly.js is unmodified. Aladin Lite carries one small patch (`static/vendor/patch_aladin.js`, to re-apply after updating the library): the "What is this?" context-menu entry queries the Harvard SIMBAD mirror and links there, and uses the CDS quick-SIMBAD service only if Harvard fails, because the CDS service has been answering 404.

| File | Library | License |
|---|---|---|
| `static/vendor/plotly.min.js` | plotly.js 2.35.2 | MIT |
| `static/vendor/aladin.js` | Aladin Lite 3.8.2 (CDS, Strasbourg), patched as described above | GPL-3.0 |

Data: NASA SPHEREx via IRSA and its AWS mirror, solar-system object positions via IRSA MOST (JPL Horizons orbits), Gaia DR3 (ESA) via STScI/MAST, object names and types via SIMBAD (CDS, Harvard mirror) and CDS Sesame.

## Acknowledgement

This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.
