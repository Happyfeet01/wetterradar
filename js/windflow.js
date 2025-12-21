// Windströmung-Layer auf Basis eines Europa-Feldes, Viewport-Cropping und strikt validierter Fetches
const WIND_ENDPOINTS = ['/wind/current.json', '/wind/fallback.json'];

// Optionen der Velocity-Layer für ein ruhigeres Partikelfeld

const VELOCITY_OPTIONS = {
  maxVelocity: 25,
  velocityScale: 0.0025,
  particleAge: 70,

  // 👇 sichtbar machen
  lineWidth: 2.5,                 // war 2
  particleMultiplier: 1 / 220,     // war 1/300 (mehr Partikel)
  opacity: 0.95,                   // war 0.9

  // 👇 wichtig: low-wind Farben dunkler, damit sie auf heller Karte sichtbar sind
  // (statt hellgrün -> eher dunkles blau/violett)
  colorScale: [
    "#1a237e", // sehr wenig Wind (dunkles Indigo)
    "#1565c0", // blau
    "#00838f", // teal
    "#2e7d32", // grün
    "#f9a825", // gelb
    "#ef6c00", // orange
    "#c62828"  // rot
  ],

  displayValues: false,
  displayOptions: {
    velocityType: 'Wind',
    position: 'bottomleft'
  }
};

const windflowLog = [];
function logWind(...args) {
  const timestamp = new Date().toISOString();
  const entry = [timestamp, ...args];
  windflowLog.push(entry);
  try {
    const trimmed = windflowLog.slice(-200);
    localStorage.setItem('windflow-log', JSON.stringify(trimmed));
  } catch (e) {
    // Ignorieren, wenn localStorage nicht verfügbar ist
  }
  console.log('[windflow]', ...entry);
}

export function bindWindFlow(L, map, ui) {
  const checkbox = ui?.chkWindFlow || document.querySelector('#chkWindFlow');
  const infoLabel = ui?.lblWindFlowInfo || document.querySelector('#lblWindFlowInfo');

  if (!checkbox) {
    console.error('Wind-Checkbox (#chkWindFlow) nicht gefunden.');
    return;
  }

  let velocityLayer = null;
  let rawWind = null;
  let loadPromise = null;
  let moveHandler = null;
  let zoomHandler = null;
  let rafId = null;

  checkbox.checked = false;
  updateInfoLabel('Wind flow: Europe');

  checkbox.addEventListener('change', () => {
    if (checkbox.checked) enableLayer();
    else disableLayer();
  });

  function updateInfoLabel(text) {
    if (!infoLabel) return;
    infoLabel.textContent = text;
  }

  function detachMapListeners() {
    if (moveHandler) map.off('moveend', moveHandler);
    if (zoomHandler) map.off('zoomend', zoomHandler);
    moveHandler = null;
    zoomHandler = null;
  }

  function disableLayer() {
    detachMapListeners();
    if (velocityLayer && map.hasLayer(velocityLayer)) {
      try {
        map.removeLayer(velocityLayer);
      } catch (err) {
        console.warn('Fehler beim Entfernen des Wind-Layers', err);
      }
    }
    velocityLayer = null;
  }

  async function enableLayer(forceReload = false, skipFetch = false) {
    updateInfoLabel('Wind flow: Europe (lädt…)');

    try {
      const data = skipFetch && rawWind ? rawWind : await loadWindData(forceReload);
      if (!data) {
        throw new Error('Keine Winddaten verfügbar');
      }
      rawWind = data;
      attachMapListeners();
      rebuildForViewport();
    } catch (err) {
      checkbox.checked = false;
      console.error('Winddaten konnten nicht geladen werden:', err);
      logWind('fetch-error', err?.message ?? err);
      updateInfoLabel('Wind flow: Europe (nicht verfügbar)');
    }
  }

  function attachMapListeners() {
    if (moveHandler || zoomHandler) return;
    const debounced = debounce(() => {
      if (checkbox.checked) rebuildForViewport();
    }, 150);

    moveHandler = debounced;
    zoomHandler = debounced;
    map.on('moveend', moveHandler);
    map.on('zoomend', zoomHandler);
  }

  function rebuildForViewport() {
    if (!rawWind) return;
    const bounds = padBounds(boundsToObj(map.getBounds()));
    const cropped = cropWindGrib(rawWind, bounds);
    scheduleUpdate(cropped);
  }

  function scheduleUpdate(payload) {
    if (!payload) return;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      applyWindData(payload);
    });
  }

  function applyWindData(payload) {
    const velocityData = buildVelocityData(payload);
    logWind('applyWindData', { zoom: map.getZoom(), hasData: !!velocityData });

    if (!velocityData) {
      updateInfoLabel('Wind flow: Europe (keine gültigen Daten)');
      if (velocityLayer && map.hasLayer(velocityLayer)) {
        try {
          map.removeLayer(velocityLayer);
        } catch (err) {
          console.warn('Fehler beim Entfernen des Wind-Layers', err);
        }
      }
      return;
    }

    const maxVelocity = payload?.meta?.stats?.maxVelocity ?? VELOCITY_OPTIONS.maxVelocity;
    const layerOptions = {
      ...VELOCITY_OPTIONS,
      data: velocityData,
      maxVelocity
    };

    try {
      if (velocityLayer && map.hasLayer(velocityLayer)) {
        map.removeLayer(velocityLayer);
      }
      velocityLayer = L.velocityLayer(layerOptions);
      map.addLayer(velocityLayer);
      safeSetOpacity(velocityLayer, VELOCITY_OPTIONS.opacity);
    } catch (err) {
      console.error('Fehler beim Erzeugen/Aktualisieren des Wind-Layers:', err, layerOptions);
      logWind('render-error', String(err));
      updateInfoLabel('Wind flow: Europe (Render-Fehler, siehe Konsole)');
      return;
    }

    const timeText = formatTimeUtc(payload.meta?.updatedAt ?? payload.generated ?? null);
    updateInfoLabel(`Wind flow: Europe${timeText ? ` (updated ${timeText} UTC)` : ''}`);
  }

  function loadWindData(forceReload = false) {
    if (!forceReload && rawWind) {
      return Promise.resolve(rawWind);
    }
    if (!forceReload && loadPromise) {
      return loadPromise;
    }

    loadPromise = fetchWithFallback()
      .then((json) => normalizeWind(json))
      .then((payload) => {
        logWind('wind payload built', { updatedAt: payload.meta?.updatedAt ?? payload.generated });
        rawWind = payload;
        return payload;
      })
      .catch((err) => {
        console.error('Winddaten konnten nicht geladen werden:', err);
        throw err;
      })
      .finally(() => {
        loadPromise = null;
      });

    return loadPromise;
  }
}

async function fetchWithFallback() {
  let lastError = null;
  for (const url of WIND_ENDPOINTS) {
    try {
      const json = await fetchWindJson(url);
      return json;
    } catch (err) {
      lastError = err;
      console.error(`Winddaten von ${url} fehlgeschlagen:`, err);
    }
  }
  throw lastError ?? new Error('Keine Winddatenquelle erreichbar');
}

async function fetchWindJson(url) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} für ${url}`);
  }
  const ct = resp.headers.get('content-type')?.toLowerCase() || '';
  const text = await resp.text();
  if (!ct.includes('application/json')) {
    const snippet = text.slice(0, 120);
    throw new Error(`Unerwarteter Content-Type für ${url}: ${ct || 'unbekannt'} (body: ${snippet})`);
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    console.error(`Unerwartete HTML-Antwort für ${url}:`, trimmed.slice(0, 120));
    throw new Error(`Unerwartete HTML-Antwort für ${url}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Ungültige JSON-Antwort für ${url}: ${err?.message ?? err}`);
  }
}

function normalizeWind(json) {
  if (!json) throw new Error('Leere Windantwort');
  const records = getWindRecords(json);
  const meta = normalizeWindMeta(json.meta ?? {}, records);
  const normalized = {
    ...json,
    meta
  };

  if (records) {
    normalized.data = records;
    normalized.field = records;
  }

  if (!normalized.generated && json.generated) {
    normalized.generated = json.generated;
  }

  return normalized;
}

function buildVelocityData(payload) {
  if (!payload) return null;
  const records = getWindRecords(payload);
  if (
    Array.isArray(records) &&
    records.length >= 2 &&
    records[0] &&
    records[0].header &&
    Array.isArray(records[0].data)
  ) {
    return records;
  }
  console.warn('buildVelocityData: keine passenden Winddaten erkannt:', payload);
  return null;
}

function samplePointsForZoom(points = [], zoom = 0) {
  const step = getSampleStep(zoom);
  if (step <= 1) return points;
  return points.filter((_, idx) => idx % step === 0);
}

function getSampleStep(zoom) {
  if (zoom <= 4) return 4;
  if (zoom <= 6) return 2;
  return 1;
}

function formatTimeUtc(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function debounce(fn, wait = 100) {
  let timeout = null;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

function boundsToObj(bounds) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  return {
    west: sw.lng,
    south: sw.lat,
    east: ne.lng,
    north: ne.lat
  };
}

function padBounds(bounds, padDeg = 0.5) {
  return {
    west: bounds.west - padDeg,
    south: bounds.south - padDeg,
    east: bounds.east + padDeg,
    north: bounds.north + padDeg
  };
}

function cropWindGrib(raw, viewBounds) {
  if (!raw) return null;
  const source = getWindRecords(raw);
  if (!Array.isArray(source) || !source.length) return raw;

  const cropped = source
    .map((entry) => cropGribField(entry, viewBounds))
    .filter(Boolean);

  if (!cropped.length) return null;

  return {
    ...raw,
    data: cropped,
    field: cropped
  };
}

function getWindRecords(raw) {
  if (!raw) return null;
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(raw.field)) return raw.field;
  return null;
}

function normalizeWindMeta(meta, records) {
  const normalized = { ...meta };
  const bounds = meta?.bounds;
  if (Array.isArray(bounds) && bounds.length === 4) {
    normalized.bounds = {
      west: bounds[0],
      south: bounds[1],
      east: bounds[2],
      north: bounds[3]
    };
  } else if (bounds && typeof bounds === 'object') {
    normalized.bounds = bounds;
  }

  if (!normalized.grid) {
    const header = records?.[0]?.header;
    const { nx, ny, dx, dy, lo1, la1, lo2, la2, scanMode } = header || {};
    if ([nx, ny, dx, dy, lo1, la1].every((v) => Number.isFinite(v))) {
      normalized.grid = {
        nx,
        ny,
        dx,
        dy,
        lo1,
        la1,
        lo2: Number.isFinite(lo2) ? lo2 : lo1 + dx * (nx - 1),
        la2: Number.isFinite(la2) ? la2 : la1 - dy * (ny - 1),
        scanMode
      };
    }
  }

  return normalized;
}

function cropGribField(field, viewBounds) {
  const header = field?.header;
  const data = field?.data;
  if (!header || !Array.isArray(data) || header.scanMode !== 0) return field;

  const { lo1, la1, nx, ny, dx, dy } = header;
  if (![lo1, la1, nx, ny, dx, dy].every((v) => Number.isFinite(v))) return field;

  const lonEnd = lo1 + dx * (nx - 1);
  const latEnd = la1 - dy * (ny - 1);

  const i0 = clamp(Math.floor((viewBounds.west - lo1) / dx), 0, nx - 1);
  const i1 = clamp(Math.ceil((viewBounds.east - lo1) / dx), 0, nx - 1);
  const j0 = clamp(Math.floor((la1 - viewBounds.north) / dy), 0, ny - 1);
  const j1 = clamp(Math.ceil((la1 - viewBounds.south) / dy), 0, ny - 1);

  if (i1 < i0 || j1 < j0) return null;

  const nxNew = i1 - i0 + 1;
  const nyNew = j1 - j0 + 1;
  const newData = [];

  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const idx = j * nx + i;
      newData.push(data[idx]);
    }
  }

  const lo1New = lo1 + dx * i0;
  const la1New = la1 - dy * j0;
  const lo2 = lo1 + dx * (nx - 1);
  const la2 = latEnd;
  const lo2New = lo1New + dx * (nxNew - 1);
  const la2New = la1New - dy * (nyNew - 1);

  return {
    header: {
      ...header,
      lo1: lo1New,
      la1: la1New,
      lo2: clamp(lo2New, lo1, lo2),
      la2: clamp(la2New, latEnd, la1),
      nx: nxNew,
      ny: nyNew
    },
    data: newData
  };
}

function safeSetOpacity(layer, opacity) {
  if (!layer || typeof layer.setOpacity !== 'function') return;
  try {
    layer.setOpacity(opacity);
  } catch (err) {
    console.warn('Konnte Opazität für Wind-Layer nicht setzen', err);
  }
}

// Export interne Helfer gebündelt für Tests (kein Public-API-Breaking)
export const __test = {
  samplePointsForZoom,
  getSampleStep,
  clamp,
  debounce,
  boundsToObj,
  padBounds,
  cropGribField,
  cropWindGrib
};
