/* ═══════════════════════════════════════════════
   HUCSat Tracker — public website port of the
   CubeSATI_MissionStation dashboard (map + 3D orbit + passes).
   Everything is computed in the browser: the latest TLE comes from
   CelesTrak and is propagated with SGP4 (satellite.js), so no
   ground-station backend is exposed.
   ═══════════════════════════════════════════════ */

(function () {
  "use strict";

  const root = document.getElementById("hucsat-tracker");
  if (!root || typeof satellite === "undefined" || typeof L === "undefined") return;

  // ── Constants (mirrors web_server.py) ──
  const NORAD_ID = 69794;
  const TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR=" + NORAD_ID + "&FORMAT=TLE";
  const TLE_CACHE_KEY = "hucsat-tle";
  const TLE_MAX_AGE_MS = 2 * 60 * 60 * 1000;   // same 2 h cadence as visualizer.py
  // Last-known TLE, used only if CelesTrak is unreachable and nothing is cached.
  const FALLBACK_TLE = [
    "1 69794U 98067YK  26296.24026803  .00046586  00000+0  64576-3 0  9994",
    "2 69794  51.6315  23.4152 0008961 316.6198  43.4088 15.56549111 17545",
  ];

  const HARVARD_LAT = 42.3736;
  const HARVARD_LON = -71.1097;
  const HARVARD_GS_ALT_M = (7 * 10 + 15) * 0.3048;
  const GS_MIN_ELEVATION_DEG = 30.0;            // antenna obstruction mask
  const TRACK_WINDOW_ORBITS = 1.1;
  const FUTURE_TRACK_ORBITS = 1.0;
  const PASS_LOOKAHEAD_ORBITS = 32.0;          // ~2 days; the 30° mask makes passes sparse
  const PASS_STEP_SEC = 10;
  const R_EARTH_KM = 6371;
  const KMS_TO_MPH = 2236.936;

  const MARKER_REFRESH_MS = 1_000;
  const TRACK_REFRESH_MS = 30_000;
  const PASS_REFRESH_MS = 60_000;

  const observerGd = {
    latitude: satellite.degreesToRadians(HARVARD_LAT),
    longitude: satellite.degreesToRadians(HARVARD_LON),
    height: HARVARD_GS_ALT_M / 1000,
  };

  // ── State ──
  let satrec = null;
  let tleEpochMs = null;
  let tleSource = "";
  let passes = [];

  const $ = function (id) { return document.getElementById(id); };

  // ──────────────────────────────────────────
  // TLE loading: fresh cache → CelesTrak → stale cache → fallback
  // ──────────────────────────────────────────

  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(TLE_CACHE_KEY));
      if (c && c.l1 && c.l2 && c.fetchedAt) return c;
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  function writeCache(l1, l2) {
    try {
      localStorage.setItem(TLE_CACHE_KEY, JSON.stringify({ l1: l1, l2: l2, fetchedAt: Date.now() }));
    } catch (e) { /* storage unavailable */ }
  }

  async function fetchTLE() {
    const resp = await fetch(TLE_URL);
    if (!resp.ok) throw new Error(resp.statusText);
    const lines = (await resp.text()).split(/\r?\n/).map(function (s) { return s.trim(); });
    const l1 = lines.find(function (s) { return s.startsWith("1 "); });
    const l2 = lines.find(function (s) { return s.startsWith("2 "); });
    if (!l1 || !l2) throw new Error("No TLE in CelesTrak response");
    return [l1, l2];
  }

  function setTLE(l1, l2, source) {
    const rec = satellite.twoline2satrec(l1, l2);
    if (rec.error) throw new Error("Bad TLE (sgp4 error " + rec.error + ")");
    satrec = rec;
    tleEpochMs = (rec.jdsatepoch - 2440587.5) * 86400000;
    tleSource = source;
  }

  async function loadTLE() {
    const cached = readCache();
    if (cached && Date.now() - cached.fetchedAt < TLE_MAX_AGE_MS) {
      setTLE(cached.l1, cached.l2, "CELESTRAK");
      return;
    }
    try {
      const tle = await fetchTLE();
      writeCache(tle[0], tle[1]);
      setTLE(tle[0], tle[1], "CELESTRAK");
    } catch (e) {
      console.warn("HUCSat tracker: TLE fetch failed, using cached/fallback TLE", e);
      if (cached) setTLE(cached.l1, cached.l2, "CACHED");
      else setTLE(FALLBACK_TLE[0], FALLBACK_TLE[1], "FALLBACK");
    }
  }

  // ──────────────────────────────────────────
  // Orbit math
  // ──────────────────────────────────────────

  function periodSec() {
    return (2 * Math.PI / satrec.no) * 60;   // satrec.no is rad/min
  }

  function stateAt(date) {
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const gmst = satellite.gstime(date);
    const gd = satellite.eciToGeodetic(pv.position, gmst);
    const v = pv.velocity;
    return {
      lat: satellite.degreesLat(gd.latitude),
      lon: satellite.degreesLong(gd.longitude),
      alt: gd.height,
      speed: Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z),
      ecf: satellite.eciToEcf(pv.position, gmst),
    };
  }

  function lookAngles(st) {
    const la = satellite.ecfToLookAngles(observerGd, st.ecf);
    return {
      az: satellite.radiansToDegrees(la.azimuth),
      el: satellite.radiansToDegrees(la.elevation),
      range: la.rangeSat,
    };
  }

  /** Sample the ground track over [startMs, endMs], split at ±180° wraps. */
  function groundTrack(startMs, endMs, nPoints) {
    const segments = [];
    let cur = [];
    let prevLon = null;
    for (let i = 0; i <= nPoints; i++) {
      const st = stateAt(new Date(startMs + (endMs - startMs) * i / nPoints));
      if (!st) continue;
      if (prevLon !== null && Math.abs(st.lon - prevLon) > 180) {
        if (cur.length >= 2) segments.push(cur);
        cur = [];
      }
      cur.push([st.lat, st.lon]);
      prevLon = st.lon;
    }
    if (cur.length >= 2) segments.push(cur);
    return segments;
  }

  /** Passes over Harvard above the obstruction mask (same rules as
   *  _find_visible_passes in web_server.py). AOS/LOS are mask crossings. */
  function findPasses(startMs) {
    const result = [];
    const endMs = startMs + PASS_LOOKAHEAD_ORBITS * periodSec() * 1000;
    let cur = null;
    for (let t = startMs; t <= endMs; t += PASS_STEP_SEC * 1000) {
      const st = stateAt(new Date(t));
      if (!st) continue;
      const la = lookAngles(st);
      if (la.el >= GS_MIN_ELEVATION_DEG) {
        if (!cur) cur = { aos: t, cpa: t, minRange: Infinity, maxEl: -90, path: [] };
        cur.path.push({ az: la.az, el: la.el });
        if (la.range < cur.minRange) { cur.minRange = la.range; cur.cpa = t; }
        if (la.el > cur.maxEl) cur.maxEl = la.el;
        cur.los = t;
      } else if (cur) {
        result.push(cur);
        cur = null;
      }
    }
    if (cur) result.push(cur);
    return result;
  }

  // ──────────────────────────────────────────
  // Leaflet map
  // ──────────────────────────────────────────

  const map = L.map("ht-map", {
    center: [20, 0],
    zoom: 1.5,
    zoomSnap: 0.5,
    minZoom: 1,
    maxZoom: 6,
    worldCopyJump: true,
    scrollWheelZoom: false,          // don't hijack page scrolling
    dragging: !L.Browser.mobile,     // let touch users scroll past the map
    attributionControl: true,
  });

  // Esri's dark basemap needs no API key (the dashboard's CARTO tiles do).
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ",
    maxZoom: 16,
  }).addTo(map);

  const terminator = L.terminator({
    stroke: false,
    fillColor: "#0b2255",
    fillOpacity: 0.4,
  }).addTo(map);
  setInterval(function () { terminator.setTime(new Date()); }, 60_000);

  const trackLines = L.layerGroup().addTo(map);
  const futureTrackLines = L.layerGroup().addTo(map);

  const satMarker = L.marker([0, 0], {
    icon: L.divIcon({
      className: "ht-icon",
      html: '<svg width="18" height="18"><circle cx="9" cy="9" r="7" fill="#ff2200" stroke="#ffb000" stroke-width="1.5"/></svg>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),
    zIndexOffset: 1000,
  }).addTo(map);
  satMarker.bindTooltip("HUCSAT", {
    permanent: true, direction: "right", offset: [10, -4], className: "ht-sat-tooltip",
  });

  L.marker([HARVARD_LAT, HARVARD_LON], {
    icon: L.divIcon({
      className: "ht-icon",
      html: '<svg width="14" height="14"><circle cx="7" cy="7" r="5" fill="crimson" stroke="white" stroke-width="0.8"/></svg>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    }),
  }).addTo(map).bindTooltip("Harvard", {
    permanent: true, direction: "right", offset: [8, -4], className: "ht-harvard-tooltip",
  });

  // Coverage circle: ground region from which HUCSat sits above the mask.
  const losCircle = L.circle([HARVARD_LAT, HARVARD_LON], {
    radius: 0,
    color: "rgba(255, 80, 80, 0.35)",
    fillColor: "rgba(255, 60, 60, 0.08)",
    fillOpacity: 1,
    weight: 1,
    dashArray: "4 4",
    interactive: false,
  }).addTo(map);

  // ──────────────────────────────────────────
  // Globe.gl 3D view
  // ──────────────────────────────────────────

  let globeViz = null;
  (function initGlobe() {
    const el = $("ht-globe");
    if (!el || typeof Globe === "undefined") return;
    try {
      globeViz = Globe({ animateIn: false })(el)
        .globeImageUrl("https://cdn.jsdelivr.net/npm/three-globe@2.45.3/example/img/earth-dark.jpg")
        .bumpImageUrl("https://cdn.jsdelivr.net/npm/three-globe@2.45.3/example/img/earth-topology.png")
        .backgroundColor("rgba(0,0,0,0)")
        .showGraticules(true)
        .showAtmosphere(true)
        .atmosphereColor("#33ff00")
        .atmosphereAltitude(0.12)
        .pathsData([])
        .pathPoints(function (d) { return d.points; })
        .pathPointLat(function (p) { return p[0]; })
        .pathPointLng(function (p) { return p[1]; })
        .pathColor(function (d) { return d.future ? "rgba(51,255,0,0.35)" : "#33ff00"; })
        .pathStroke(function (d) { return d.future ? 1.0 : 1.5; })
        .pathDashLength(function (d) { return d.future ? 3 : 1; })
        .pathDashGap(function (d) { return d.future ? 3 : 0; })
        .pathTransitionDuration(0)
        .pointsData([])
        .pointColor(function () { return "#ff2200"; })
        .pointAltitude(0.02)
        .pointRadius(0.6)
        .pointOfView({ lat: 38, lng: -96, altitude: 2.2 });

      const controls = globeViz.controls();
      controls.autoRotate = false;
      controls.enableZoom = false;   // don't hijack page scrolling

      new ResizeObserver(function () {
        globeViz.width(el.clientWidth).height(el.clientHeight);
      }).observe(el);
    } catch (e) {
      console.error("Globe init failed:", e);
      globeViz = null;
    }
  })();

  // ──────────────────────────────────────────
  // Formatting
  // ──────────────────────────────────────────

  function formatEta(totalSeconds) {
    const sec = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const hh = String(Math.floor(sec / 3600)).padStart(2, "0");
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    return hh + ":" + mm + ":" + ss;
  }

  function formatEastern(ms) {
    return new Date(ms).toLocaleTimeString("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
  }

  function formatEasternDay(ms) {
    return new Date(ms).toLocaleString("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit",
    });
  }

  function etaText(ms, now) {
    return ms <= now ? "NOW" : "T-" + formatEta((ms - now) / 1000);
  }

  // ──────────────────────────────────────────
  // Refreshers
  // ──────────────────────────────────────────

  let lastState = null;

  function refreshMarker() {
    const now = Date.now();
    const st = stateAt(new Date(now));
    if (!st) return;
    lastState = st;
    satMarker.setLatLng([st.lat, st.lon]);
    if (globeViz) globeViz.pointsData([{ lat: st.lat, lng: st.lon }]);

    const inc = satellite.radiansToDegrees(satrec.inclo);
    $("ht-hud-pos").textContent =
      "LAT " + st.lat.toFixed(2) + "°  LON " + st.lon.toFixed(2) + "°";
    $("ht-hud-orbit").textContent =
      "ALT " + st.alt.toFixed(0) + " km   " +
      "VEL " + st.speed.toFixed(2) + " km/s (" + Math.round(st.speed * KMS_TO_MPH).toLocaleString("en-US") + " mph)   " +
      "INC " + inc.toFixed(2) + "°   " +
      "PERIOD " + (periodSec() / 60).toFixed(1) + " min";

    const eMin = GS_MIN_ELEVATION_DEG * Math.PI / 180;
    const rSat = R_EARTH_KM + st.alt;
    const theta = Math.acos((R_EARTH_KM / rSat) * Math.cos(eMin)) - eMin;
    losCircle.setRadius(Math.max(0, R_EARTH_KM * theta * 1000));

    $("ht-clock").textContent = new Date(now).toISOString().slice(11, 19) + " UTC";
    const ageH = (now - tleEpochMs) / 3.6e6;
    $("ht-tle").textContent = "TLE " + tleSource + " · EPOCH " +
      (ageH < 48 ? ageH.toFixed(1) + " h" : (ageH / 24).toFixed(1) + " d") + " AGO";

    tickPasses(now);
    drawApproachPolar();
  }

  function refreshTrack() {
    const now = Date.now();
    const p = periodSec() * 1000;
    const past = groundTrack(now - TRACK_WINDOW_ORBITS * p, now, Math.round(TRACK_WINDOW_ORBITS * 300));
    const future = groundTrack(now, now + FUTURE_TRACK_ORBITS * p, Math.round(FUTURE_TRACK_ORBITS * 300));

    trackLines.clearLayers();
    past.forEach(function (seg) {
      L.polyline(seg, { color: "#33ff00", weight: 2, opacity: 0.85 }).addTo(trackLines);
    });
    futureTrackLines.clearLayers();
    future.forEach(function (seg) {
      L.polyline(seg, { color: "#33ff00", weight: 1.5, opacity: 0.45, dashArray: "6 6" }).addTo(futureTrackLines);
    });

    if (globeViz) {
      globeViz.pathsData(
        past.map(function (s) { return { points: s, future: false }; })
          .concat(future.map(function (s) { return { points: s, future: true }; }))
      );
    }
  }

  function refreshPasses() {
    // Start one step back so a pass already in progress is still found.
    passes = findPasses(Date.now() - 15 * 60 * 1000).filter(function (p) {
      return p.los >= Date.now();
    });
  }

  function setVal(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function tickPasses(now) {
    if (passes.length && passes[0].los < now) refreshPasses();
    const awaiting = $("ht-awaiting-feed");
    if (!passes.length) {
      if (awaiting) awaiting.classList.remove("ht-hidden");
      return;
    }
    if (awaiting) awaiting.classList.add("ht-hidden");

    const cp = passes[0];
    const inPass = cp.aos <= now;
    setVal("ht-next-label", inPass ? "Overhead now" : "Next pass over Harvard");
    setVal("ht-aos", etaText(cp.aos, now) + "  ·  " + formatEastern(cp.aos));
    setVal("ht-cpa", etaText(cp.cpa, now) + "  ·  " + formatEastern(cp.cpa));
    setVal("ht-los", "T-" + formatEta((cp.los - now) / 1000) + "  ·  " + formatEastern(cp.los));
    setVal("ht-min", cp.minRange.toFixed(0) + " km  ·  max el " + cp.maxEl.toFixed(0) + "°");

    for (let i = 0; i < 3; i++) {
      const p = passes[i + 1];
      setVal("ht-upcoming-" + i, p
        ? formatEasternDay(p.aos) + "  ·  " + Math.round((p.los - p.aos) / 60000) + " min  ·  max el " + p.maxEl.toFixed(0) + "°"
        : "--");
    }
  }

  // ──────────────────────────────────────────
  // Approach polar plot (ported from dashboard.js drawApproachPolar)
  // ──────────────────────────────────────────

  const approachCanvas = $("ht-polar");
  const approachCtx = approachCanvas ? approachCanvas.getContext("2d") : null;

  function drawApproachPolar() {
    if (!approachCanvas || !approachCtx) return;
    const rect = approachCanvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;

    const dpr = window.devicePixelRatio || 1;
    const pixW = Math.max(2, Math.round(rect.width * dpr));
    const pixH = Math.max(2, Math.round(rect.height * dpr));
    if (approachCanvas.width !== pixW || approachCanvas.height !== pixH) {
      approachCanvas.width = pixW;
      approachCanvas.height = pixH;
    }
    const ctx = approachCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const w = rect.width;
    const h = rect.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.max(10, Math.min(w, h) * 0.38);
    const toXY = function (az, el) {
      const rr = ((90 - Math.max(0, Math.min(90, el))) / 90) * radius;
      const rad = az * Math.PI / 180;
      return { x: cx + rr * Math.sin(rad), y: cy - rr * Math.cos(rad) };
    };

    // Obstruction mask annulus (el below GS_MIN_ELEVATION_DEG is blocked).
    const rMask = ((90 - GS_MIN_ELEVATION_DEG) / 90) * radius;
    ctx.fillStyle = "rgba(255, 60, 60, 0.13)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2, false);
    ctx.arc(cx, cy, rMask, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 80, 80, 0.5)";
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, rMask, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = "rgba(51, 255, 0, 0.22)";
    for (const el of [0, 30, 60, 90]) {
      ctx.beginPath();
      ctx.arc(cx, cy, ((90 - el) / 90) * radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const az of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const p = toXY(az, 0);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    ctx.fillStyle = "#7a9a5a";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const labelRadius = radius + 14;
    for (const lbl of [{ az: 0, t: "N" }, { az: 90, t: "E" }, { az: 180, t: "S" }, { az: 270, t: "W" }]) {
      const rad = lbl.az * Math.PI / 180;
      ctx.fillText(lbl.t, cx + labelRadius * Math.sin(rad), cy - labelRadius * Math.cos(rad));
    }
    ctx.textAlign = "right";
    for (const elTick of [0, 30, 60]) {
      ctx.fillText(elTick + "°", cx + ((90 - elTick) / 90) * radius - 3, cy - 8);
    }

    const cp = passes[0];
    if (!cp || cp.path.length < 2) return;

    // Dim-to-bright path: AOS -> LOS gradient to show pass direction.
    const pts = cp.path.map(function (p) { return toXY(p.az, p.el); });
    const denom = Math.max(1, pts.length - 1);
    for (let i = 1; i < pts.length; i++) {
      const t = i / denom;
      const r = Math.round(255 + (51 - 255) * t);
      const g = Math.round(176 + (255 - 176) * t);
      ctx.strokeStyle = "rgba(" + r + ", " + g + ", 0, " + (0.25 + 0.75 * t).toFixed(3) + ")";
      ctx.lineWidth = 1.2 + 1.4 * t;
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(255, 176, 0, 0.55)";
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Live position while the pass is in progress.
    if (lastState && cp.aos <= Date.now()) {
      const la = lookAngles(lastState);
      if (la.el > 0) {
        const p = toXY(la.az, la.el);
        ctx.fillStyle = "#ff2200";
        ctx.strokeStyle = "#ffb000";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // ──────────────────────────────────────────
  // Startup
  // ──────────────────────────────────────────

  loadTLE().then(function () {
    root.classList.add("ht-ready");
    refreshTrack();
    refreshPasses();
    refreshMarker();
    if (lastState) map.setView([lastState.lat, lastState.lon], map.getZoom());
    if (globeViz && lastState) {
      globeViz.pointOfView({ lat: lastState.lat, lng: lastState.lon, altitude: 2.2 });
    }
    setInterval(refreshMarker, MARKER_REFRESH_MS);
    setInterval(refreshTrack, TRACK_REFRESH_MS);
    setInterval(refreshPasses, PASS_REFRESH_MS);
    setInterval(function () {
      loadTLE().catch(function (e) { console.error("TLE reload failed:", e); });
    }, TLE_MAX_AGE_MS);
  }).catch(function (e) {
    console.error("HUCSat tracker failed to start:", e);
    setVal("ht-tle", "TRACKER UNAVAILABLE");
  });
})();
