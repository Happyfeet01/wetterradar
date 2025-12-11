// Windströmung-Layer mit auswählbaren Regionen und zoom-abhängigem Downsampling
const REGION_SOURCES = {
  germany: {
    label: 'Germany',
    path: '/wind/current.json',
    // grobe Bounds für Deutschland
    bounds: [
      [47.0, 5.0], // Südwest (lat, lon)
      [55.5, 15.5] // Nordost
    ]
  },
  europe: {
    label: 'Europe',
    path: '/wind/current.json',
    bounds: [
      [33.0, -12.0], // Südwest, passend zu meta.bounds
      [72.0, 33.0] // Nordost
    ]
  },
  world: {
    label: 'World',
    path: '/wind/current.json',
    bounds: [
      [-60.0, -180.0],
      [85.0, 180.0]
    ]
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
  let rafId = null;
  let currentRegion = regionSelect?.value || 'germany';
  const payloadCache = new Map();
  const loadPromises = new Map();

  checkbox.checked = false;
  updateInfoLabel('Wind flow: Germany');

  if (ui?.chkDark) {
    ui.chkDark.addEventListener('change', () => {
      if (velocityLayer && typeof velocityLayer.setOpacity === 'function') {
        velocityLayer.setOpacity(VELOCITY_OPTIONS.opacity);
        logWind('Dark mode toggled, reset opacity');
      }
    });
  }

  checkbox.addEventListener('change', () => {
    if (checkbox.checked) enableLayer();
    else disableLayer();
  });

  regionSelect?.addEventListener('change', () => {
    currentRegion = regionSelect.value || 'germany';
    updateInfoLabel(`Wind flow: ${REGION_SOURCES[currentRegion]?.label ?? 'Region'}`);
    if (checkbox.checked) enableLayer(true);
  });

  map.on('zoomend', () => {
    if (checkbox.checked && payloadCache.has(currentRegion)) {
      const payload = payloadCache.get(currentRegion);
      scheduleUpdate(payload, currentRegion);
    }
  });

  function disableLayer() {
    if (velocityLayer && map.hasLayer(velocityLayer)) {
      map.removeLayer(velocityLayer);
    }
  }

  async function enableLayer(forceReload = false) {
    updateInfoLabel(`Wind flow: ${REGION_SOURCES[currentRegion]?.label ?? 'Region'} (lädt…)`);

    const data = await getWindData(currentRegion, forceReload);
    if (!data) {
      checkbox.checked = false;
      updateInfoLabel(`Wind flow: ${REGION_SOURCES[currentRegion]?.label ?? 'Region'} (nicht verfügbar)`);
      return;
    }

    scheduleUpdate(data, currentRegion);
    if (velocityLayer && !map.hasLayer(velocityLayer)) {
      map.addLayer(velocityLayer);
    }
  }

  function updateInfoLabel(text) {
    if (!infoLabel) return;
    infoLabel.textContent = text;
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
        map.removeLayer(velocityLayer);
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
      if (velocityLayer && typeof velocityLayer.setData === 'function') {
        // vorhandenen Layer aktualisieren
        velocityLayer.setData(velocityData);
        if (typeof velocityLayer.setOptions === 'function') {
          velocityLayer.setOptions({ maxVelocity, opacity: VELOCITY_OPTIONS.opacity });
        }
      } else {
        // alten Layer entfernen, falls vorhanden
        if (velocityLayer && map.hasLayer(velocityLayer)) {
          map.removeLayer(velocityLayer);
        }
        // neuen Layer erstellen
        velocityLayer = L.velocityLayer(layerOptions);
        if (typeof velocityLayer.setOpacity === 'function') {
          velocityLayer.setOpacity(VELOCITY_OPTIONS.opacity);
        }
        map.addLayer(velocityLayer);
      }
    } catch (err) {
      console.error('Fehler beim Erzeugen/Aktualisieren des Wind-Layers:', err, layerOptions);
      logWind('render-error', err?.message ?? err);
      updateInfoLabel(`Wind flow: ${region.label} (Render-Fehler, siehe Konsole)`);
      return;
    }

    // Map-Ausschnitt an die Region anpassen, wenn Bounds gesetzt sind
    if (region.bounds && Array.isArray(region.bounds) && region.bounds.length === 2) {
      try {
        map.fitBounds(region.bounds, { padding: [20, 20] });
        logWind('fitBounds', regionKey, region.bounds);
      } catch (e) {
        console.warn('Konnte Bounds für Region nicht anwenden:', regionKey, e);
        logWind('fitBounds-error', regionKey, e?.message ?? e);
      }
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

function diffs(values) {
  const arr = [];
  for (let i = 1; i < values.length; i++) {
    const diff = Math.abs(values[i] - values[i - 1]);
    if (Number.isFinite(diff) && diff > 0) arr.push(diff);
  }
  return arr.length ? arr : [1];
}

// Export interne Helfer gebündelt für Tests (kein Public-API-Breaking)
export const __test = {
  samplePointsForZoom,
  getSampleStep
};
