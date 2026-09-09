// Windströmungs-Layer auf Basis eines gecachten Vektorfeldes.
// Das Feld wird nur bei Bedarf geladen, regelmäßig revalidiert und für den
// sichtbaren Kartenausschnitt zugeschnitten.
const WIND_ENDPOINTS = ['/wind/current.json', '/wind/fallback.json'];
const WIND_REFRESH_MS = 15 * 60 * 1000;
const WIND_FETCH_TIMEOUT_MS = 10000;
const WIND_STALE_AFTER_MS = 12 * 60 * 60 * 1000;
const VIEWPORT_PAD_DEG = 1.5;

const VELOCITY_OPTIONS = {
  maxVelocity: 25,
  velocityScale: 0.0025,
  particleAge: 70,
  lineWidth: 2.5,
  particleMultiplier: 1 / 220,
  opacity: 0.95,
  colorScale: [
    '#1a237e',
    '#1565c0',
    '#00838f',
    '#2e7d32',
    '#f9a825',
    '#ef6c00',
    '#c62828'
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
    localStorage.setItem('windflow-log', JSON.stringify(windflowLog.slice(-200)));
  } catch {
    // localStorage ist z. B. in Tests oder restriktiven Browsermodi nicht verfügbar.
  }
  console.log('[windflow]', ...entry);
}

export function bindWindFlow(L, map, ui) {
  const checkbox = ui?.chkWindFlow || document.querySelector('#chkWindFlow');
  const infoLabel = ui?.lblWindFlowInfo || document.querySelector('#lblWindFlowInfo');
  const regionSelect = ui?.selWindRegion || document.querySelector('#selWindRegion');

  if (!checkbox) {
    console.error('Wind-Checkbox (#chkWindFlow) nicht gefunden.');
    return;
  }

  let velocityLayer = null;
  let rawWind = null;
  let loadPromise = null;
  let lastFetchAt = 0;
  let moveHandler = null;
  let zoomHandler = null;
  let rafId = null;
  let refreshTimer = null;
  let activationToken = 0;
  let lastRenderKey = null;

  checkbox.checked = false;

  // Das veröffentlichte Vektorfeld deckt derzeit Europa ab. Die alten
  // Deutschland/Welt-Optionen suggerierten eine Funktion, die es nicht gab.
  if (regionSelect) {
    regionSelect.value = 'europe';
    regionSelect.disabled = true;
    regionSelect.title = 'Der Windströmungs-Layer verwendet aktuell ein Europa-Datenfeld.';
  }

  updateInfoLabel('Windströmung: Europa');

  checkbox.addEventListener('change', () => {
    if (checkbox.checked) void enableLayer();
    else disableLayer();
  });

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && checkbox.checked) void refreshWindData();
    });
  }

  function updateInfoLabel(text) {
    if (infoLabel) infoLabel.textContent = text;
  }

  function detachMapListeners() {
    if (moveHandler) map.off('moveend', moveHandler);
    if (zoomHandler) map.off('zoomend', zoomHandler);
    moveHandler = null;
    zoomHandler = null;
  }

  function stopRefreshTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function startRefreshTimer() {
    stopRefreshTimer();
    refreshTimer = setInterval(() => {
      if (!checkbox.checked) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshWindData();
    }, WIND_REFRESH_MS);
  }

  function removeVelocityLayer() {
    if (velocityLayer && map.hasLayer(velocityLayer)) {
      try {
        map.removeLayer(velocityLayer);
      } catch (err) {
        console.warn('Fehler beim Entfernen des Wind-Layers', err);
      }
    }
    velocityLayer = null;
  }

  function disableLayer() {
    activationToken += 1;
    stopRefreshTimer();
    detachMapListeners();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    lastRenderKey = null;
    removeVelocityLayer();
    updateInfoLabel('Windströmung: aus');
  }

  async function enableLayer(forceReload = false) {
    const token = ++activationToken;
    updateInfoLabel('Windströmung: lädt…');

    try {
      const shouldReload = forceReload || !rawWind || Date.now() - lastFetchAt >= WIND_REFRESH_MS;
      const data = await loadWindData(shouldReload);
      if (!data) throw new Error('Keine Winddaten verfügbar');

      // Wurde der Toggle während des Fetches wieder ausgeschaltet, darf der
      // verspätete Request den Layer nicht heimlich wieder einschalten.
      if (!checkbox.checked || token !== activationToken) return;

      rawWind = data;
      attachMapListeners();
      startRefreshTimer();
      rebuildForViewport(true);
    } catch (err) {
      if (token !== activationToken) return;
      checkbox.checked = false;
      console.error('Winddaten konnten nicht geladen werden:', err);
      logWind('fetch-error', err?.message ?? err);
      updateInfoLabel('Windströmung: nicht verfügbar');
    }
  }

  async function refreshWindData() {
    if (!checkbox.checked) return;

    const previous = rawWind;
    const previousVersion = windDataVersion(previous);
    try {
      const candidate = await loadWindData(true);
      if (!checkbox.checked || !candidate) return;

      // Ein Fallback darf ein bereits neueres Datenfeld nicht zurückdrehen.
      const previousTime = windDataTimestamp(previous);
      const candidateTime = windDataTimestamp(candidate);
      if (previous && Number.isFinite(previousTime) && Number.isFinite(candidateTime) && candidateTime < previousTime) {
        logWind('ignored-older-wind-payload', {
          current: new Date(previousTime).toISOString(),
          candidate: new Date(candidateTime).toISOString()
        });
        updateWindInfo(previous);
        return;
      }

      rawWind = candidate;
      const nextVersion = windDataVersion(candidate);
      if (nextVersion !== previousVersion) {
        lastRenderKey = null;
        rebuildForViewport(true);
      } else {
        updateWindInfo(candidate);
      }
    } catch (err) {
      // Bei einem Refresh-Fehler bleibt der vorhandene Film sichtbar.
      console.warn('Winddaten-Aktualisierung fehlgeschlagen, vorhandene Daten bleiben aktiv:', err);
      logWind('refresh-error', err?.message ?? err);
      if (rawWind) updateWindInfo(rawWind, true);
    }
  }

  function attachMapListeners() {
    if (moveHandler || zoomHandler) return;
    const debounced = debounce(() => {
      if (checkbox.checked) rebuildForViewport(false);
    }, 180);

    moveHandler = debounced;
    zoomHandler = debounced;
    map.on('moveend', moveHandler);
    map.on('zoomend', zoomHandler);
  }

  function rebuildForViewport(force = false) {
    if (!rawWind || !checkbox.checked) return;
    const bounds = padBounds(boundsToObj(map.getBounds()), VIEWPORT_PAD_DEG);
    const cropped = cropWindGrib(rawWind, bounds);

    if (!cropped) {
      lastRenderKey = null;
      removeVelocityLayer();
      updateInfoLabel('Windströmung: außerhalb des Datenbereichs');
      return;
    }

    const renderKey = buildRenderKey(cropped);
    if (!force && renderKey && renderKey === lastRenderKey) return;
    scheduleUpdate(cropped, renderKey);
  }

  function scheduleUpdate(payload, renderKey) {
    if (!payload) return;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (!checkbox.checked) return;
      applyWindData(payload, renderKey);
    });
  }

  function applyWindData(payload, renderKey) {
    const velocityData = buildVelocityData(payload);
    logWind('applyWindData', { zoom: map.getZoom(), hasData: !!velocityData, renderKey });

    if (!velocityData) {
      updateInfoLabel('Windströmung: keine gültigen Daten');
      removeVelocityLayer();
      return;
    }

    const maxVelocity = getMaxVelocity(payload);
    const layerOptions = {
      ...VELOCITY_OPTIONS,
      data: velocityData,
      maxVelocity
    };

    try {
      if (velocityLayer && map.hasLayer(velocityLayer) && typeof velocityLayer.setData === 'function') {
        // leaflet-velocity unterstützt setData offiziell. Dadurch wird beim
        // Nachladen oder Verschieben nicht jedes Mal ein kompletter Layer
        // entfernt und neu angelegt.
        if (typeof velocityLayer.setOptions === 'function') {
          velocityLayer.setOptions({ maxVelocity });
        }
        velocityLayer.setData(velocityData);
      } else {
        removeVelocityLayer();
        velocityLayer = L.velocityLayer(layerOptions);
        map.addLayer(velocityLayer);
      }
      safeSetOpacity(velocityLayer, VELOCITY_OPTIONS.opacity);
      lastRenderKey = renderKey;
      updateWindInfo(payload);
    } catch (err) {
      console.error('Fehler beim Erzeugen/Aktualisieren des Wind-Layers:', err, layerOptions);
      logWind('render-error', String(err));
      updateInfoLabel('Windströmung: Render-Fehler');
    }
  }

  function loadWindData(forceReload = false) {
    if (!forceReload && rawWind) return Promise.resolve(rawWind);
    // Auch erzwungene Refreshes werden serialisiert. Sonst könnten Timer,
    // Sichtbarkeitswechsel und Toggle gleichzeitig dieselbe große JSON laden.
    if (loadPromise) return loadPromise;

    loadPromise = fetchWithFallback()
      .then(json => normalizeWind(json))
      .then(payload => {
        lastFetchAt = Date.now();
        logWind('wind payload loaded', {
          datasetTime: payload.meta?.datasetTime,
          updatedAt: payload.meta?.updatedAt ?? payload.generated
        });
        return payload;
      })
      .finally(() => {
        loadPromise = null;
      });

    return loadPromise;
  }

  function updateWindInfo(payload, refreshFailed = false) {
    const datasetIso = getWindDatasetIso(payload);
    const timeText = formatTimeUtc(datasetIso);
    const timestamp = windDataTimestamp(payload);
    const stale = Number.isFinite(timestamp) && Date.now() - timestamp > WIND_STALE_AFTER_MS;
    const suffix = [
      timeText ? `Daten ${timeText} UTC` : null,
      stale ? 'veraltet' : null,
      refreshFailed ? 'Refresh fehlgeschlagen' : null
    ].filter(Boolean).join(' · ');
    updateInfoLabel(`Windströmung: Europa${suffix ? ` (${suffix})` : ''}`);
  }
}

async function fetchWithFallback() {
  let lastError = null;
  for (const url of WIND_ENDPOINTS) {
    try {
      return await fetchWindJson(url);
    } catch (err) {
      lastError = err;
      console.error(`Winddaten von ${url} fehlgeschlagen:`, err);
    }
  }
  throw lastError ?? new Error('Keine Winddatenquelle erreichbar');
}

async function fetchWindJson(url, timeoutMs = WIND_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // no-cache erlaubt dem Browser eine günstige ETag/Last-Modified-Revalidierung,
    // statt die große JSON bei jedem Poll blind neu herunterzuladen.
    const resp = await fetch(url, { cache: 'no-cache', signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} für ${url}`);

    const ct = resp.headers.get('content-type')?.toLowerCase() || '';
    const text = await resp.text();
    if (!ct.includes('application/json')) {
      const snippet = text.slice(0, 120);
      throw new Error(`Unerwarteter Content-Type für ${url}: ${ct || 'unbekannt'} (body: ${snippet})`);
    }
    const trimmed = text.trim();
    if (trimmed.startsWith('<')) {
      throw new Error(`Unerwartete HTML-Antwort für ${url}`);
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`Ungültige JSON-Antwort für ${url}: ${err?.message ?? err}`);
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`Timeout nach ${timeoutMs} ms für ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeWind(json) {
  if (!json) throw new Error('Leere Windantwort');
  const records = getWindRecords(json);
  const meta = normalizeWindMeta(json.meta ?? {}, records);
  const normalized = { ...json, meta };

  if (records) {
    normalized.data = records;
    normalized.field = records;
  }
  return normalized;
}

function buildVelocityData(payload) {
  if (!payload) return null;
  const records = getWindRecords(payload);
  if (
    Array.isArray(records) &&
    records.length >= 2 &&
    records[0]?.header &&
    Array.isArray(records[0].data) &&
    records[1]?.header &&
    Array.isArray(records[1].data)
  ) {
    return records;
  }
  console.warn('buildVelocityData: keine passenden Winddaten erkannt:', payload);
  return null;
}

function getMaxVelocity(payload) {
  const values = [
    payload?.meta?.stats?.maxVelocity,
    payload?.stats?.maxVelocity
  ].map(Number).filter(Number.isFinite);
  return values[0] ?? VELOCITY_OPTIONS.maxVelocity;
}

function getWindDatasetIso(payload) {
  return payload?.meta?.datasetTime
    ?? payload?.data?.[0]?.header?.refTime
    ?? payload?.field?.[0]?.header?.refTime
    ?? payload?.meta?.updatedAt
    ?? payload?.meta?.generated
    ?? payload?.generated
    ?? null;
}

function windDataTimestamp(payload) {
  const value = getWindDatasetIso(payload);
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function windDataVersion(payload) {
  if (!payload) return null;
  const dataset = getWindDatasetIso(payload);
  if (dataset) return String(dataset);
  return payload?.meta?.updatedAt ?? payload?.meta?.generated ?? payload?.generated ?? null;
}

function buildRenderKey(payload) {
  const records = getWindRecords(payload);
  const header = records?.[0]?.header;
  if (!header) return windDataVersion(payload);
  return [
    windDataVersion(payload),
    header.lo1,
    header.la1,
    header.lo2,
    header.la2,
    header.nx,
    header.ny
  ].join('|');
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
    .map(entry => cropGribField(entry, viewBounds))
    .filter(Boolean);

  if (!cropped.length || cropped.length !== source.length) return null;

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
    if ([nx, ny, dx, dy, lo1, la1].every(v => Number.isFinite(v))) {
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
  if (![lo1, la1, nx, ny, dx, dy].every(v => Number.isFinite(v))) return field;
  if (nx <= 0 || ny <= 0 || dx <= 0 || dy <= 0) return field;

  const lonEnd = lo1 + dx * (nx - 1);
  const latEnd = la1 - dy * (ny - 1);
  const dataWest = Math.min(lo1, lonEnd);
  const dataEast = Math.max(lo1, lonEnd);
  const dataSouth = Math.min(la1, latEnd);
  const dataNorth = Math.max(la1, latEnd);

  // Vor dem Clamping echten Überlapp prüfen. Sonst wurde bei einem Viewport
  // außerhalb Europas fälschlich die äußerste Rasterzeile/-spalte gerendert.
  if (
    viewBounds.east < dataWest ||
    viewBounds.west > dataEast ||
    viewBounds.north < dataSouth ||
    viewBounds.south > dataNorth
  ) {
    return null;
  }

  const i0 = clamp(Math.floor((viewBounds.west - lo1) / dx), 0, nx - 1);
  const i1 = clamp(Math.ceil((viewBounds.east - lo1) / dx), 0, nx - 1);
  const j0 = clamp(Math.floor((la1 - viewBounds.north) / dy), 0, ny - 1);
  const j1 = clamp(Math.ceil((la1 - viewBounds.south) / dy), 0, ny - 1);

  if (i1 < i0 || j1 < j0) return null;

  const nxNew = i1 - i0 + 1;
  const nyNew = j1 - j0 + 1;
  const newData = [];

  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      newData.push(data[j * nx + i]);
    }
  }

  const lo1New = lo1 + dx * i0;
  const la1New = la1 - dy * j0;
  const lo2New = lo1New + dx * (nxNew - 1);
  const la2New = la1New - dy * (nyNew - 1);

  return {
    header: {
      ...header,
      lo1: lo1New,
      la1: la1New,
      lo2: clamp(lo2New, dataWest, dataEast),
      la2: clamp(la2New, dataSouth, dataNorth),
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

export const __test = {
  WIND_REFRESH_MS,
  WIND_FETCH_TIMEOUT_MS,
  WIND_STALE_AFTER_MS,
  samplePointsForZoom,
  getSampleStep,
  clamp,
  debounce,
  boundsToObj,
  padBounds,
  cropGribField,
  cropWindGrib,
  buildRenderKey,
  getWindDatasetIso,
  windDataTimestamp,
  windDataVersion,
  fetchWindJson
};
