// Windströmung-Layer mit auswählbaren Regionen und viewport-basiertem Cropping
const REGION_SOURCES = {
  germany: {
    label: 'Germany',
    path: '/data/wind-germany.json'
  },
  europe: {
    label: 'Europe',
    path: '/data/wind-europe.json'
  },
  world: {
    label: 'World',
    path: '/data/wind-global.json'
  }
};

// Anteil der Punkte je Zoomstufe (über Modulo stabil und deterministisch)
const ZOOM_SAMPLING = [
  { maxZoom: 4, step: 4 }, // 25 %
  { maxZoom: 6, step: 2 }, // 50 %
  { maxZoom: Infinity, step: 1 } // 100 %
];

// Optionen der Velocity-Layer für ein ruhigeres Partikelfeld
const VELOCITY_OPTIONS = {
  maxVelocity: 25, // wird später dynamisch mit meta.stats.maxVelocity überschrieben
  velocityScale: 0.0025, // ruhiger als ganz früher, aber nicht zu langsam
  particleAge: 70,
  lineWidth: 2, // etwas dicker -> besser sichtbar
  particleMultiplier: 1 / 300,
  opacity: 0.9, // fast volle Deckkraft
  // Farbskala mit hoher Sichtbarkeit auf hellen UND dunklen Karten
  colorScale: ['#00ffff', '#00ff00', '#ffff00', '#ff8000', '#ff0000'],
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
  const regionSelect = ui?.selWindRegion || document.querySelector('#selWindRegion');
  const infoLabel = ui?.lblWindFlowInfo || document.querySelector('#lblWindFlowInfo');

  if (!checkbox) {
    console.error('Wind-Checkbox (#chkWindFlow) nicht gefunden.');
    return;
  }

  let velocityLayer = null;
  let currentRegion = regionSelect?.value || 'germany';
  let lastRawWind = null;
  let moveHandler = null;
  let zoomHandler = null;
  let rafId = null;
  const payloadCache = new Map();
  const loadPromises = new Map();

  checkbox.checked = false;
  updateInfoLabel('Wind flow: Germany');

  checkbox.addEventListener('change', () => {
    if (checkbox.checked) enableLayer();
    else disableLayer();
  });

  regionSelect?.addEventListener('change', () => {
    currentRegion = regionSelect.value || 'germany';
    updateInfoLabel(`Wind flow: ${REGION_SOURCES[currentRegion]?.label ?? 'Region'}`);
    if (checkbox.checked) enableLayer(true);
  });

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

  async function enableLayer(forceReload = false) {
    updateInfoLabel(`Wind flow: ${REGION_SOURCES[currentRegion]?.label ?? 'Region'} (lädt…)`);

    const data = await getWindData(currentRegion, forceReload);
    if (!data) {
      checkbox.checked = false;
      updateInfoLabel(`Wind flow: ${REGION_SOURCES[currentRegion]?.label ?? 'Region'} (nicht verfügbar)`);
      return;
    }

    lastRawWind = data;
    attachMapListeners();
    rebuildForViewport();
  }

  function updateInfoLabel(text) {
    if (!infoLabel) return;
    infoLabel.textContent = text;
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

  function detachMapListeners() {
    if (moveHandler) map.off('moveend', moveHandler);
    if (zoomHandler) map.off('zoomend', zoomHandler);
    moveHandler = null;
    zoomHandler = null;
  }

  function rebuildForViewport() {
    if (!lastRawWind) return;
    const bounds = padBounds(boundsToObj(map.getBounds()));
    const cropped = cropWindGrib(lastRawWind, bounds);
    scheduleUpdate(cropped, currentRegion);
  }

  function scheduleUpdate(payload, regionKey) {
    if (!payload) return;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      applyWindData(payload, regionKey);
    });
  }

  function applyWindData(payload, regionKey) {
    const region = REGION_SOURCES[regionKey] ?? { label: 'Region' };

    const velocityData = buildVelocityData(payload, map.getZoom());
    logWind('applyWindData', { regionKey, zoom: map.getZoom(), hasData: !!velocityData });

    if (!velocityData) {
      updateInfoLabel(`Wind flow: ${region.label} (keine gültigen Daten)`);
      if (velocityLayer && map.hasLayer(velocityLayer)) {
        try {
          map.removeLayer(velocityLayer);
        } catch (err) {
          console.warn('Fehler beim Entfernen des Wind-Layers', err);
        }
      }
      return;
    }

    const maxVelocity =
      payload?.meta?.stats?.maxVelocity ?? VELOCITY_OPTIONS.maxVelocity;

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
      updateInfoLabel(`Wind flow: ${region.label} (Render-Fehler, siehe Konsole)`);
      return;
    }

    const timeText = formatTimeUtc(
      payload.meta?.updatedAt ?? payload.generated ?? null
    );

    updateInfoLabel(
      `Wind flow: ${region.label}${
        timeText ? ` (updated ${timeText} UTC)` : ''
      }`
    );
  }

  function getWindData(regionKey, forceReload = false) {
    if (!forceReload && payloadCache.has(regionKey)) {
      return Promise.resolve(payloadCache.get(regionKey));
    }
    if (!forceReload && loadPromises.has(regionKey)) {
      return loadPromises.get(regionKey);
    }

    const source = REGION_SOURCES[regionKey];
    if (!source?.path) {
      return Promise.resolve(null);
    }

    const promise = fetch(source.path, { cache: 'no-store' })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const ct = resp.headers.get('content-type')?.toLowerCase() || '';
        if (!ct.includes('application/json')) {
          throw new Error(`Unerwarteter Content-Type: ${ct || 'unbekannt'}`);
        }
        return resp.json();
      })
      .then((json) => {
        logWind('wind raw json', json?.meta?.updatedAt ?? json?.generated ?? '');
        if (!json) return null;
        const payload = {
          meta: json.meta ?? {},
          data: json.data ?? json.field ?? null,
          field: json.field ?? null,
          generated: json.meta?.generated ?? json.generated ?? null
        };
        logWind('wind payload built', { regionKey, updatedAt: payload.meta?.updatedAt ?? payload.generated });
        payloadCache.set(regionKey, payload);
        return payload;
      })
      .catch((err) => {
        console.error('Winddaten konnten nicht geladen werden:', err);
        logWind('fetch-error', regionKey, err?.message ?? err);
        return null;
      })
      .finally(() => {
        loadPromises.delete(regionKey);
      });

    loadPromises.set(regionKey, promise);
    return promise;
  }
}

function buildVelocityData(payload, zoom) {
  if (!payload) return null;

  // Fall A: neue Struktur (current.json) mit data-Array (GRIB-ähnlich)
  if (
    Array.isArray(payload.data) &&
    payload.data.length >= 2 &&
    payload.data[0] &&
    payload.data[0].header &&
    Array.isArray(payload.data[0].data)
  ) {
    return payload.data;
  }

  // Fall B: älteres field-Format
  if (
    Array.isArray(payload.field) &&
    payload.field.length &&
    payload.field[0] &&
    payload.field[0].header &&
    Array.isArray(payload.field[0].data)
  ) {
    return payload.field;
  }

  // Alles andere ignorieren
  console.warn('buildVelocityData: keine passenden Winddaten erkannt:', payload);
  return null;
}

function samplePointsForZoom(points = [], zoom = 0) {
  const step = getSampleStep(zoom);
  if (step <= 1) return points;
  return points.filter((_, idx) => idx % step === 0);
}

function getSampleStep(zoom) {
  for (const rule of ZOOM_SAMPLING) {
    if (zoom <= rule.maxZoom) return Math.max(1, rule.step);
  }
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
  const source = Array.isArray(raw.data) ? raw.data : raw.field;
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
  cropGribField
};
