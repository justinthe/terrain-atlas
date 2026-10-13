/* Humbang Terrain Sheet — two synced MapLibre maps over one blended DEM. */
const params = new URLSearchParams(location.search);
const DATA = (params.get("data") || "https://huggingface.co/datasets/the-justin/humbang-food-estate-tiles/resolve/main/").replace(/\/?$/, "/");
const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const GLYPHS = "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf";
// Highland agri ramp: wet valley teal -> paddy green -> dry ochre -> ridge terracotta -> bare crest.
const RAMP = ["#0f3b3a", "#1d6a5b", "#4a9461", "#98b866", "#d8ce7c", "#e8aa5b", "#cf6f3f", "#9c4636", "#f3ead6"];
const FALLBACK_META = { bounds: [98.68219, 2.36661, 98.7531, 2.41417], dsm_zoom: [14, 18] };

const $ = (s) => document.querySelector(s);
const stage = $(".stage");

/* ---------- elevation tiles: drone DSM (z14-18) blended over AWS Terrarium ---------- */
const pm = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", pm.tile);
const dsmArchive = new pmtiles.PMTiles(DATA + "dsm.pmtiles");
let DSM_Z = FALLBACK_META.dsm_zoom;

const bytesCache = new Map();
const gridCache = new Map();
const remember = (map, key, value, max = 400) => {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
  return value;
};

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.arrayBuffer();
}

async function decode(buf) {
  const bmp = await createImageBitmap(new Blob([buf]));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  const out = new Float32Array(d.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  return out;
}

async function encode(h) {
  const img = new ImageData(256, 256);
  const d = img.data;
  for (let i = 0; i < h.length; i++) {
    const v = h[i] + 32768;
    const f = Math.floor(v);
    d[i * 4] = Math.floor(f / 256);
    d[i * 4 + 1] = f % 256;
    d[i * 4 + 2] = Math.floor((v - f) * 256);
    d[i * 4 + 3] = 255;
  }
  const c = new OffscreenCanvas(256, 256);
  c.getContext("2d").putImageData(img, 0, 0);
  return (await c.convertToBlob({ type: "image/png" })).arrayBuffer();
}

// Bilinear upsample of one parent tile into child (cx, cy) at scale k, pixel-centre convention
// (matches scipy.ndimage.zoom(grid_mode=True) used to pre-blend the DSM tiles).
function upsample(parent, k, cx, cy) {
  const out = new Float32Array(65536);
  for (let j = 0; j < 256; j++) {
    const sy = Math.min(255, Math.max(0, (cy * 256 + j + 0.5) / k - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(255, y0 + 1), fy = sy - y0;
    for (let i = 0; i < 256; i++) {
      const sx = Math.min(255, Math.max(0, (cx * 256 + i + 0.5) / k - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(255, x0 + 1), fx = sx - x0;
      const top = parent[y0 * 256 + x0] * (1 - fx) + parent[y0 * 256 + x1] * fx;
      const bot = parent[y1 * 256 + x0] * (1 - fx) + parent[y1 * 256 + x1] * fx;
      out[j * 256 + i] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}

function tileBytes(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (bytesCache.has(key)) return bytesCache.get(key);
  const p = (async () => {
    if (z >= DSM_Z[0] && z <= DSM_Z[1]) {
      const t = await dsmArchive.getZxy(z, x, y).catch(() => null);
      if (t?.data) return t.data;
    }
    if (z <= 15) return fetchBytes(`${TERRARIUM}${z}/${x}/${y}.png`);
    const k = 2 ** (z - 15);
    const parent = await elevationGrid(15, Math.floor(x / k), Math.floor(y / k));
    return encode(upsample(parent, k, x % k, y % k));
  })();
  p.catch(() => bytesCache.delete(key));
  return remember(bytesCache, key, p);
}

function elevationGrid(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (gridCache.has(key)) return gridCache.get(key);
  const p = tileBytes(z, x, y).then(decode);
  p.catch(() => gridCache.delete(key));
  return remember(gridCache, key, p, 200);
}

maplibregl.addProtocol("blend", async (req) => {
  const [z, x, y] = req.url.slice("blend://".length).split("/").map(Number);
  return { data: await tileBytes(z, x, y) };
});

async function elevationAt(lng, lat, z) {
  const n = 2 ** z;
  const fx = ((lng + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const x = Math.floor(fx), y = Math.floor(fy);
  if (x < 0 || y < 0 || x >= n || y >= n) return NaN;
  const g = await elevationGrid(z, x, y);
  return g[Math.min(255, Math.floor((fy - y) * 256)) * 256 + Math.min(255, Math.floor((fx - x) * 256))];
}

/* ---------- styles ---------- */
const demSource = () => ({ type: "raster-dem", tiles: ["blend://{z}/{x}/{y}"], tileSize: 256, encoding: "terrarium", maxzoom: 18 });
const limitSource = (b) => ({
  type: "geojson",
  data: { type: "Feature", geometry: { type: "LineString", coordinates: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]] } },
});
const limitLayer = { id: "limit", type: "line", source: "limit", paint: { "line-color": "#ff5b1f", "line-width": 1.6, "line-dasharray": [3, 2] } };
const reliefColor = (lo, hi) => ["interpolate", ["linear"], ["elevation"], ...RAMP.flatMap((c, i) => [lo + ((hi - lo) * i) / (RAMP.length - 1), c])];

function surfaceStyle(b) {
  return {
    version: 8,
    sources: {
      esri: { type: "raster", tiles: [ESRI], tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
      ortho: { type: "raster", url: `pmtiles://${DATA}ortho.pmtiles`, tileSize: 256, attribution: "Drone orthomosaic 2021" },
      dem: demSource(),
      limit: limitSource(b),
    },
    layers: [
      { id: "esri", type: "raster", source: "esri", paint: { "raster-saturation": -0.15 } },
      { id: "ortho", type: "raster", source: "ortho", paint: { "raster-fade-duration": 150 } },
      limitLayer,
    ],
  };
}

function reliefStyle(b, lo, hi) {
  const isIndex = ["==", ["%", ["round", ["to-number", ["get", "elev"]]], 10], 0];
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      dem: demSource(),
      shade: demSource(),
      contours: { type: "vector", url: `pmtiles://${DATA}contours.pmtiles` },
      limit: limitSource(b),
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#1b211d" } },
      { id: "relief", type: "color-relief", source: "shade", paint: { "color-relief-color": reliefColor(lo, hi) } },
      {
        id: "hillshade", type: "hillshade", source: "shade",
        paint: { "hillshade-exaggeration": 0.5, "hillshade-shadow-color": "rgba(16,20,17,0.6)", "hillshade-highlight-color": "rgba(255,250,232,0.35)", "hillshade-accent-color": "rgba(0,0,0,0)" },
      },
      { id: "contours", type: "line", source: "contours", "source-layer": "contour", filter: ["!", isIndex], minzoom: 15, paint: { "line-color": "rgba(29,36,32,0.45)", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.3, 17, 0.9] } },
      { id: "contours-index", type: "line", source: "contours", "source-layer": "contour", filter: isIndex, paint: { "line-color": "#1d2420", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.8, 17, 1.8] } },
      {
        id: "contours-label", type: "symbol", source: "contours", "source-layer": "contour", filter: isIndex, minzoom: 15,
        layout: { "symbol-placement": "line", "text-field": ["to-string", ["round", ["to-number", ["get", "elev"]]]], "text-font": ["Noto Sans Medium"], "text-size": 10.5, "symbol-spacing": 320, "text-pitch-alignment": "viewport" },
        paint: { "text-color": "#1d2420", "text-halo-color": "rgba(243,234,214,0.85)", "text-halo-width": 1.4 },
      },
      limitLayer,
    ],
  };
}

/* ---------- boot ---------- */
(async function main() {
  const meta = await fetch("meta.json").then((r) => r.json()).catch(() => FALLBACK_META);
  DSM_Z = meta.dsm_zoom || DSM_Z;
  const b = meta.bounds;
  const center = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  fillLedger(meta);

  const STATIONS = [
    { name: "Overview", note: "Whole survey, oblique from the south-east", fit: true, pitch: 55, bearing: -25 },
    { name: "Plan view", note: "Straight down, north up", fit: true, pitch: 0, bearing: 0 },
    { name: "From the north", note: "Looking south across the block", fit: true, pitch: 68, bearing: 180, dz: 0.5 },
    { name: "From the west", note: "Looking east along the fields", fit: true, pitch: 68, bearing: 90, dz: 0.5 },
    { name: "Low pass", note: "Field-level detail at the centre", center, zoom: 17, pitch: 72, bearing: 35 },
    { name: "Toba context", note: "The survey within the Toba highlands", center: [98.86, 2.47], zoom: 10.4, pitch: 55, bearing: 20 },
  ];

  let exaggeration = Number($("#scale").value);
  const lo0 = meta.elevation?.p1 ?? 1300, hi0 = meta.elevation?.p99 ?? 1500;
  const common = { maxPitch: 85, attributionControl: false, center, zoom: 13, pitch: 55, bearing: -25 };
  const surface = new maplibregl.Map({ container: "map-surface", style: surfaceStyle(b), ...common });
  const relief = new maplibregl.Map({ container: "map-relief", style: reliefStyle(b, lo0, hi0), interactive: false, ...common });
  surface.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
  surface.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  window.maps = { surface, relief };

  for (const m of [surface, relief]) m.on("load", () => m.setTerrain({ source: "dem", exaggeration }));

  // Sync: the visible (relief) map follows the interactive one.
  const sync = () => relief.jumpTo({ center: surface.getCenter(), zoom: surface.getZoom(), bearing: surface.getBearing(), pitch: surface.getPitch() });
  surface.on("move", () => { sync(); updateCamera(); });

  /* stations */
  const nav = $("#stations");
  nav.innerHTML = STATIONS.map((s, i) => `<button class="station" data-i="${i}"><span class="no">${String(i + 1).padStart(2, "0")}</span><span><b>${s.name}</b><small>${s.note}</small></span><span class="glyph">→</span></button>`).join("");
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest(".station");
    if (btn) goTo(Number(btn.dataset.i));
  });

  function goTo(i, instant = false) {
    const s = STATIONS[i];
    nav.querySelectorAll(".station").forEach((el) => el.setAttribute("aria-current", String(Number(el.dataset.i) === i)));
    setOrbit(false);
    let cam = { center: s.center, zoom: s.zoom, pitch: s.pitch, bearing: s.bearing };
    if (s.fit) {
      const fit = surface.cameraForBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, bearing: s.bearing });
      cam = { center: fit.center, zoom: fit.zoom + (s.dz || 0), pitch: s.pitch, bearing: s.bearing };
    }
    stage.classList.add("is-loading");
    // Listen before moving: jumpTo fires moveend synchronously.
    surface.once("moveend", () => {
      const idle = (m) => new Promise((r) => { m.once("idle", r); setTimeout(r, 9000); });
      Promise.all([idle(surface), idle(relief)]).then(() => { stage.classList.remove("is-loading"); fitRamp(); setOrbit(s.pitch > 0 && s.name !== "Low pass"); });
    });
    if (instant) surface.jumpTo(cam);
    else surface.flyTo({ ...cam, duration: 2600, essential: true });
  }

  /* orbit */
  let orbitOn = false, orbitFrame = 0, last = 0;
  function setOrbit(on) {
    orbitOn = on && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    $('[data-layer="orbit"]').setAttribute("aria-pressed", String(orbitOn));
    cancelAnimationFrame(orbitFrame);
    if (!orbitOn) return;
    last = performance.now();
    const tick = (t) => {
      if (!orbitOn) return;
      surface.setBearing(surface.getBearing() + ((t - last) / 1000) * 2.4);
      last = t;
      orbitFrame = requestAnimationFrame(tick);
    };
    orbitFrame = requestAnimationFrame(tick);
  }
  for (const ev of ["mousedown", "touchstart", "wheel"]) surface.on(ev, () => setOrbit(false));

  /* toggles */
  document.querySelectorAll(".toggle").forEach((btn) => btn.addEventListener("click", () => {
    const on = btn.getAttribute("aria-pressed") !== "true";
    const layer = btn.dataset.layer;
    btn.setAttribute("aria-pressed", String(on));
    const vis = on ? "visible" : "none";
    if (layer === "orbit") setOrbit(on);
    else if (layer === "ortho") surface.setLayoutProperty("ortho", "visibility", vis);
    else if (layer === "hillshade") relief.setLayoutProperty("hillshade", "visibility", vis);
    else for (const id of ["contours", "contours-index", "contours-label"]) relief.setLayoutProperty(id, "visibility", vis);
  }));

  /* vertical scale */
  $("#scale").addEventListener("input", (e) => {
    exaggeration = Number(e.target.value);
    $("#scaleOut").textContent = `${exaggeration.toFixed(1)}×`;
    for (const m of [surface, relief]) if (m.getTerrain()) m.setTerrain({ source: "dem", exaggeration });
    updateCamera();
  });

  /* swipe tape */
  const tape = $(".tape");
  const setSplit = (p) => {
    p = Math.max(10, Math.min(90, p));
    $("#relief-clip").style.clipPath = `inset(0 0 0 ${p}%)`;
    tape.style.left = `${p}%`;
    $(".tag-b").style.left = `calc(${p}% + 14px)`;
    tape.setAttribute("aria-valuenow", String(Math.round(p)));
  };
  let dragging = false;
  tape.addEventListener("pointerdown", (e) => { dragging = true; tape.setPointerCapture(e.pointerId); });
  tape.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = stage.getBoundingClientRect();
    setSplit(((e.clientX - r.left) / r.width) * 100);
  });
  tape.addEventListener("pointerup", () => { dragging = false; });
  tape.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setSplit(Number(tape.getAttribute("aria-valuenow")) + (e.key === "ArrowRight" ? 2 : -2));
  });
  setSplit(50);

  /* cursor probe */
  const probe = $("#probe");
  let probeAt = 0, probeSeq = 0;
  surface.on("mousemove", async (e) => {
    probe.classList.add("on");
    probe.style.left = `${e.point.x}px`;
    probe.style.top = `${e.point.y}px`;
    const now = performance.now();
    if (now - probeAt < 70) return;
    probeAt = now;
    const seq = ++probeSeq;
    const { lng, lat } = e.lngLat;
    const z = Math.max(0, Math.min(18, Math.round(surface.getZoom()) + 1));
    const h = await elevationAt(lng, lat, z).catch(() => NaN);
    if (seq !== probeSeq) return;
    probe.querySelector("b").textContent = Number.isFinite(h) ? `${h.toLocaleString(undefined, { maximumFractionDigits: 1 })} m` : "—";
    probe.querySelector("span").textContent = `${fmtLat(lat)}  ${fmtLng(lng)}`;
  });
  surface.getCanvas().addEventListener("mouseleave", () => probe.classList.remove("on"));

  /* auto-fit elevation ramp to what's on screen */
  let fitSeq = 0;
  async function fitRamp() {
    const seq = ++fitSeq;
    const { width, height } = surface.getCanvas().getBoundingClientRect();
    const z = Math.max(0, Math.min(18, Math.floor(surface.getZoom())));
    const pts = [];
    for (let j = 1; j < 14; j++) for (let i = 1; i < 14; i++) {
      const ll = surface.unproject([(width * i) / 14, (height * j) / 14]);
      if (Math.abs(ll.lat) < 85) pts.push(ll);
    }
    const hs = (await Promise.all(pts.map((p) => elevationAt(p.lng, p.lat, z).catch(() => NaN)))).filter(Number.isFinite).sort((a, b) => a - b);
    if (seq !== fitSeq || hs.length < 10) return;
    let lo = hs[Math.floor(hs.length * 0.04)], hi = hs[Math.ceil((hs.length - 1) * 0.96)];
    const pad = Math.max((hi - lo) * 0.05, 4);
    lo -= pad; hi += pad;
    if (hi - lo < 20) { const m = (hi + lo) / 2; lo = m - 10; hi = m + 10; }
    setRamp(lo, hi);
  }
  function setRamp(lo, hi) {
    if (relief.getLayer("relief")) relief.setPaintProperty("relief", "color-relief-color", reliefColor(lo, hi));
    const step = niceStep((hi - lo) / 5);
    const ticks = [lo];
    for (let v = Math.ceil(lo / step) * step; v < hi; v += step) if (v - lo > step * 0.4 && hi - v > step * 0.4) ticks.push(v);
    ticks.push(hi);
    $("#ticks").innerHTML = ticks.map((v) => `<span style="left:${((v - lo) / (hi - lo)) * 100}%">${Math.round(v).toLocaleString()}</span>`).join("");
  }
  $("#ramp").style.background = `linear-gradient(90deg, ${RAMP.join(", ")})`;
  setRamp(lo0, hi0);
  let fitTimer = 0;
  surface.on("moveend", () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitRamp, 250); });

  /* camera ledger */
  function updateCamera() {
    const c = surface.getCenter();
    $("#camera").innerHTML = [
      ["LAT", fmtLat(c.lat)], ["LON", fmtLng(c.lng)], ["Z", surface.getZoom().toFixed(1)],
      ["BRG", `${String(Math.round((surface.getBearing() + 360) % 360)).padStart(3, "0")}°`],
      ["PITCH", `${Math.round(surface.getPitch())}°`], ["V", `${exaggeration.toFixed(1)}×`],
    ].map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join("");
  }

  surface.once("load", () => goTo(0, true));
  updateCamera();
})();

function fillLedger(meta) {
  const set = (k, v) => { const el = document.querySelector(`[data-k="${k}"]`); if (el && v) el.textContent = v; };
  const e = meta.elevation;
  set("area", meta.area_km2 && `${meta.area_km2.toLocaleString()} km²`);
  if (e) {
    set("elev", `${Math.round(e.p1).toLocaleString()}–${Math.round(e.p99).toLocaleString()} m`);
    set("relief", `${Math.round(e.p99 - e.p1)} m`);
  }
  if (meta.datum_offset_m != null) set("datum", `${meta.datum_offset_m > 0 ? "−" : "+"}${Math.abs(meta.datum_offset_m).toFixed(1)} m`);
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
}
const fmtLat = (v) => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? "N" : "S"}`;
const fmtLng = (v) => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? "E" : "W"}`;
