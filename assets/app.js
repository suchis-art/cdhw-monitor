(function () {
  "use strict";

  const state = {
    meta: null,
    variable: null,
    data: null,
    timeIndex: 0,
    speed: 5,
    playing: false,
    playTimer: null,
    hoverCell: null,
    basemapReady: false
  };

  const els = {
    basemap: document.getElementById("basemap-layer"),
    canvas: document.getElementById("map-canvas"),
    loading: document.getElementById("loading"),
    variable: document.getElementById("variable-select"),
    date: document.getElementById("date-input"),
    slider: document.getElementById("time-slider"),
    speed: document.getElementById("speed-slider"),
    speedValue: document.getElementById("speed-value"),
    play: document.getElementById("play-button"),
    download: document.getElementById("download-button"),
    currentDate: document.getElementById("current-date"),
    currentVariable: document.getElementById("current-variable"),
    roLat: document.getElementById("readout-lat"),
    roLon: document.getElementById("readout-lon"),
    roValue: document.getElementById("readout-value"),
    dayValid: document.getElementById("day-valid"),
    dayActive: document.getElementById("day-active"),
    dayMean: document.getElementById("day-mean"),
    dayMax: document.getElementById("day-max"),
    legend: document.getElementById("legend"),
    period: document.getElementById("summary-period"),
    grid: document.getElementById("summary-grid"),
    topYear: document.getElementById("summary-top-year")
  };

  const ctx = els.canvas.getContext("2d");
  const map = {
    left: 72,
    right: 28,
    top: 28,
    bottom: 58,
    topoZoom: 5,
    tileSize: 256
  };

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function dateForIndex(i) {
    if (Array.isArray(state.meta.time_values) && state.meta.time_values[i]) {
      return new Date(state.meta.time_values[i] + "T00:00:00Z");
    }
    const d = new Date(state.meta.time_start + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + i * (state.meta.time_step_days || 1));
    return d;
  }

  function isoForIndex(i) {
    const d = dateForIndex(i);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }

  function prettyDate(i) {
    return dateForIndex(i).toLocaleDateString("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "long",
      day: "numeric"
    });
  }

  function formatValue(v, variable) {
    if (!Number.isFinite(v)) return "-";
    if (variable.kind === "flag") return v === 1 ? "Yes" : "No";
    if (variable.kind === "days") return `${Math.round(v)} days`;
    if (variable.units) return `${v.toFixed(2)} ${variable.units}`;
    return v.toFixed(2);
  }

  function colorRamp(t) {
    const stops = [
      [0.00, [255, 255, 204]],
      [0.20, [255, 237, 160]],
      [0.40, [254, 178, 76]],
      [0.62, [240, 59, 32]],
      [0.82, [189, 0, 38]],
      [1.00, [95, 0, 64]]
    ];
    const x = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i++) {
      if (x <= stops[i][0]) {
        const [p0, c0] = stops[i - 1];
        const [p1, c1] = stops[i];
        const f = (x - p0) / (p1 - p0 || 1);
        const rgb = c0.map((c, j) => Math.round(c + (c1[j] - c) * f));
        return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      }
    }
    return "rgb(95,0,64)";
  }

  function scaleBounds(variable) {
    if (variable.kind === "days") return { min: 0, max: variable.max || 1 };
    const pMin = Number.isFinite(variable.p02) ? variable.p02 : variable.min;
    const pMax = Number.isFinite(variable.p98) ? variable.p98 : variable.max;
    if (Number.isFinite(pMin) && Number.isFinite(pMax) && pMax > pMin) {
      return { min: pMin, max: pMax };
    }
    return { min: Number.isFinite(variable.min) ? variable.min : 0, max: Number.isFinite(variable.max) ? variable.max : 1 };
  }

  function colorForValue(v, variable) {
    if (!Number.isFinite(v)) return "rgba(255, 255, 255, .22)";
    if (variable.kind === "flag") return v === 1 ? "rgba(179, 59, 34, .72)" : "rgba(255, 255, 255, .16)";
    if (variable.transparent_zero && v <= 0) return null;
    const { min, max } = scaleBounds(variable);
    const t = (v - min) / (max - min || 1);
    return colorRamp(t);
  }

  function playbackDelay() {
    const slowMs = 1000;
    const fastMs = 60;
    const t = (state.speed - 1) / 9;
    return Math.round(slowMs - t * (slowMs - fastMs));
  }

  function stopPlayback() {
    state.playing = false;
    window.clearInterval(state.playTimer);
    els.play.setAttribute("aria-pressed", "false");
    els.play.innerHTML = "<span aria-hidden=\"true\">▶</span>";
  }

  function startPlayback() {
    state.playing = true;
    els.play.setAttribute("aria-pressed", "true");
    els.play.innerHTML = "<span aria-hidden=\"true\">Ⅱ</span>";
    window.clearInterval(state.playTimer);
    state.playTimer = window.setInterval(() => {
      setTimeIndex((state.timeIndex + 1) % state.meta.time_count);
    }, playbackDelay());
  }

  function updateSpeed(value) {
    state.speed = Math.max(1, Math.min(10, Number(value) || 5));
    els.speedValue.textContent = `${state.speed}x`;
    if (state.playing) startPlayback();
  }

  function getValue(timeIndex, row, col) {
    const { lat_count: rows, lon_count: cols } = state.meta;
    const idx = timeIndex * rows * cols + row * cols + col;
    const v = state.data[idx];
    if (state.variable.dtype === "uint8") return v === 255 ? NaN : v;
    return Number.isFinite(v) ? v : NaN;
  }

  function project(lon, lat) {
    const { lon_min, lon_max, lat_min, lat_max } = state.meta;
    const w = els.canvas.width - map.left - map.right;
    const h = els.canvas.height - map.top - map.bottom;
    return {
      x: map.left + ((lon - lon_min) / (lon_max - lon_min)) * w,
      y: map.top + ((lat_max - lat) / (lat_max - lat_min)) * h
    };
  }

  function lonToTileX(lon, zoom) {
    return ((lon + 180) / 360) * Math.pow(2, zoom);
  }

  function latToTileY(lat, zoom) {
    const latRad = lat * Math.PI / 180;
    return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, zoom);
  }

  function renderBasemapTiles() {
    if (!els.basemap || !state.meta) return;
    const z = map.topoZoom;
    const tileSize = map.tileSize;
    const x0 = lonToTileX(state.meta.lon_min, z);
    const x1 = lonToTileX(state.meta.lon_max, z);
    const y0 = latToTileY(state.meta.lat_max, z);
    const y1 = latToTileY(state.meta.lat_min, z);
    const minX = Math.floor(x0);
    const maxX = Math.floor(x1);
    const minY = Math.floor(y0);
    const maxY = Math.floor(y1);
    const scaleX = 100 / (x1 - x0);
    const scaleY = 100 / (y1 - y0);
    const frag = document.createDocumentFragment();

    els.basemap.textContent = "";
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const img = document.createElement("img");
        img.className = "basemap-tile";
        img.alt = "";
        img.decoding = "async";
        img.loading = "eager";
        img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${z}/${y}/${x}`;
        img.style.left = `${(x - x0) * scaleX}%`;
        img.style.top = `${(y - y0) * scaleY}%`;
        img.style.width = `${scaleX}%`;
        img.style.height = `${scaleY}%`;
        frag.appendChild(img);
      }
    }
    els.basemap.appendChild(frag);
    state.basemapReady = true;
  }

  function cellFromPoint(x, y) {
    const { lat_values: lats, lon_values: lons, lat_step, lon_step } = state.meta;
    const { lon_min, lon_max, lat_min, lat_max } = state.meta;
    const w = els.canvas.width - map.left - map.right;
    const h = els.canvas.height - map.top - map.bottom;
    const lon = lon_min + ((x - map.left) / w) * (lon_max - lon_min);
    const lat = lat_max - ((y - map.top) / h) * (lat_max - lat_min);
    const col = Math.round((lon - lons[0]) / lon_step);
    const row = Math.round((lat - lats[0]) / lat_step);
    if (row < 0 || col < 0 || row >= lats.length || col >= lons.length) return null;
    return { row, col, lat: lats[row], lon: lons[col] };
  }

  function drawGridFrame() {
    const { lat_values: lats, lon_values: lons, lat_step, lon_step } = state.meta;
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    ctx.fillStyle = "rgba(255, 255, 255, .72)";
    ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
    ctx.clearRect(map.left, map.top, els.canvas.width - map.left - map.right, els.canvas.height - map.top - map.bottom);

    const halfLat = lat_step / 2;
    const halfLon = lon_step / 2;
    let valid = 0;
    let active = 0;
    let sum = 0;
    let max = -Infinity;

    for (let r = 0; r < lats.length; r++) {
      for (let c = 0; c < lons.length; c++) {
        const v = getValue(state.timeIndex, r, c);
        const p0 = project(lons[c] - halfLon, lats[r] + halfLat);
        const p1 = project(lons[c] + halfLon, lats[r] - halfLat);
        const color = colorForValue(v, state.variable);
        if (color) {
          ctx.fillStyle = color;
          ctx.globalAlpha = state.variable.kind === "flag" ? 1 : 0.74;
          ctx.fillRect(Math.round(p0.x), Math.round(p0.y), Math.ceil(p1.x - p0.x), Math.ceil(p1.y - p0.y));
          ctx.globalAlpha = 1;
        }
        if (Number.isFinite(v)) {
          valid += 1;
          sum += v;
          max = Math.max(max, v);
          if (v > 0) active += 1;
        }
      }
    }

    ctx.strokeStyle = "rgba(46, 56, 58, .18)";
    ctx.lineWidth = 1;
    for (const lat of lats) {
      const p0 = project(state.meta.lon_min, lat);
      const p1 = project(state.meta.lon_max, lat);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    for (const lon of lons) {
      const p0 = project(lon, state.meta.lat_min);
      const p1 = project(lon, state.meta.lat_max);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(45, 57, 60, .82)";
    ctx.lineWidth = 2;
    ctx.strokeRect(map.left, map.top, els.canvas.width - map.left - map.right, els.canvas.height - map.top - map.bottom);

    ctx.fillStyle = "#2d393c";
    ctx.font = "13px Inter, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Longitude", els.canvas.width / 2, els.canvas.height - 18);
    ctx.save();
    ctx.translate(22, els.canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Latitude", 0, 0);
    ctx.restore();

    drawHover();
    updateDayStats(valid, active, sum, max);
  }

  function drawHover() {
    if (!state.hoverCell) return;
    const { row, col } = state.hoverCell;
    const lat = state.meta.lat_values[row];
    const lon = state.meta.lon_values[col];
    const p0 = project(lon - state.meta.lon_step / 2, lat + state.meta.lat_step / 2);
    const p1 = project(lon + state.meta.lon_step / 2, lat - state.meta.lat_step / 2);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 3;
    ctx.strokeRect(Math.round(p0.x), Math.round(p0.y), Math.ceil(p1.x - p0.x), Math.ceil(p1.y - p0.y));
  }

  function updateDayStats(valid, active, sum, max) {
    els.dayValid.textContent = String(valid);
    els.dayActive.textContent = String(active);
    if (!valid) {
      els.dayMean.textContent = "-";
    } else if (state.variable.kind === "flag") {
      els.dayMean.textContent = `${((active / valid) * 100).toFixed(1)}%`;
    } else {
      els.dayMean.textContent = formatValue(sum / valid, state.variable);
    }
    els.dayMax.textContent = Number.isFinite(max) ? formatValue(max, state.variable) : "-";
  }

  function updateLabels() {
    els.currentDate.textContent = prettyDate(state.timeIndex);
    els.currentVariable.textContent = state.variable.label;
    els.date.value = isoForIndex(state.timeIndex);
    els.slider.value = String(state.timeIndex);
  }

  function renderLegend() {
    const variable = state.variable;
    els.legend.innerHTML = "";
    if (variable.kind === "flag") {
      els.legend.innerHTML = `
        <div class="legend-bar" style="background: linear-gradient(90deg, #f2eadf 0 50%, #b33b22 50% 100%)"></div>
        <div class="legend-row"><span>No event</span><span>Event</span></div>
      `;
      return;
    }
    const { min, max } = scaleBounds(variable);
    els.legend.innerHTML = `
      <div class="legend-bar" style="background: linear-gradient(90deg, ${colorRamp(0)}, ${colorRamp(.2)}, ${colorRamp(.4)}, ${colorRamp(.62)}, ${colorRamp(.82)}, ${colorRamp(1)})"></div>
      <div class="legend-row"><span>${min.toFixed(2)}</span><span>${max.toFixed(2)}</span></div>
    `;
  }

  async function loadVariable(name) {
    const variable = state.meta.variables[name];
    state.variable = variable;
    els.loading.classList.remove("hidden");
    els.loading.textContent = `Loading ${variable.label}...`;
    const res = await fetch(variable.file);
    if (!res.ok) throw new Error(`Could not load ${variable.file}`);
    const buffer = await res.arrayBuffer();
    state.data = variable.dtype === "uint8" ? new Uint8Array(buffer) : new Float32Array(buffer);
    els.loading.classList.add("hidden");
    renderLegend();
    updateLabels();
    drawGridFrame();
  }

  function populateControls() {
    for (const [name, variable] of Object.entries(state.meta.variables)) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = variable.label;
      els.variable.appendChild(option);
    }
    els.slider.max = String(state.meta.time_count - 1);
    els.date.min = state.meta.time_start;
    els.date.max = state.meta.time_end;
    updateSpeed(els.speed.value);
    els.period.textContent = `${state.meta.time_start} to ${state.meta.time_end}`;
    els.grid.textContent = `${state.meta.lat_count} x ${state.meta.lon_count} at ${state.meta.lat_step}°`;
    const topList = state.meta.annual_top && (state.meta.annual_top.heatwave_drought || state.meta.annual_top.weekly_cdhw_severity);
    const top = topList && topList[0];
    els.topYear.textContent = top ? `${top.year} (${Math.round(top.value)} grid-days)` : "-";
  }

  function setTimeIndex(i) {
    state.timeIndex = Math.max(0, Math.min(state.meta.time_count - 1, Number(i) || 0));
    updateLabels();
    drawGridFrame();
  }

  function dateToIndex(value) {
    if (Array.isArray(state.meta.time_values)) {
      let best = 0;
      let bestDist = Infinity;
      const target = new Date(value + "T00:00:00Z").getTime();
      state.meta.time_values.forEach((iso, i) => {
        const dist = Math.abs(new Date(iso + "T00:00:00Z").getTime() - target);
        if (dist < bestDist) {
          best = i;
          bestDist = dist;
        }
      });
      return best;
    }
    const start = new Date(state.meta.time_start + "T00:00:00Z");
    const date = new Date(value + "T00:00:00Z");
    return Math.round((date - start) / (86400000 * (state.meta.time_step_days || 1)));
  }

  function wireEvents() {
    els.variable.addEventListener("change", () => loadVariable(els.variable.value));
    els.slider.addEventListener("input", () => setTimeIndex(els.slider.value));
    els.speed.addEventListener("input", () => updateSpeed(els.speed.value));
    els.date.addEventListener("change", () => setTimeIndex(dateToIndex(els.date.value)));
    els.play.addEventListener("click", () => {
      if (state.playing) stopPlayback();
      else startPlayback();
    });
    els.download.addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = els.canvas.toDataURL("image/png");
      a.download = `conus-cdhw-${els.variable.value}-${isoForIndex(state.timeIndex)}.png`;
      a.click();
    });
    els.canvas.addEventListener("mousemove", (event) => {
      const rect = els.canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) * (els.canvas.width / rect.width);
      const y = (event.clientY - rect.top) * (els.canvas.height / rect.height);
      state.hoverCell = cellFromPoint(x, y);
      if (state.hoverCell) {
        const v = getValue(state.timeIndex, state.hoverCell.row, state.hoverCell.col);
        els.roLat.textContent = `${state.hoverCell.lat.toFixed(2)}°N`;
        els.roLon.textContent = `${Math.abs(state.hoverCell.lon).toFixed(2)}°W`;
        els.roValue.textContent = formatValue(v, state.variable);
      } else {
        els.roLat.textContent = "-";
        els.roLon.textContent = "-";
        els.roValue.textContent = "-";
      }
      drawGridFrame();
    });
    els.canvas.addEventListener("mouseleave", () => {
      state.hoverCell = null;
      els.roLat.textContent = "-";
      els.roLon.textContent = "-";
      els.roValue.textContent = "-";
      drawGridFrame();
    });
  }

  async function init() {
    const res = await fetch("data/metadata.json");
    if (!res.ok) throw new Error("data/metadata.json is missing. Run scripts/export_cdhw_web.py first.");
    state.meta = await res.json();
    renderBasemapTiles();
    populateControls();
    wireEvents();
    const initial = state.meta.default_variable || Object.keys(state.meta.variables)[0];
    els.variable.value = initial;
    await loadVariable(initial);
  }

  init().catch((error) => {
    els.loading.textContent = error.message;
    console.error(error);
  });
})();
