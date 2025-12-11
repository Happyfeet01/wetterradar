// Windströmung-Layer mit auswählbaren Regionen und zoom-abhängigem Downsampling
const REGION_SOURCES = {
  germany: { label: 'Germany', path: '/wind/current.json' },
  europe: { label: 'Europe', path: '/wind/current.json' },
  world: { label: 'World', path: '/wind/current.json' }
};

// Anteil der Punkte je Zoomstufe (über Modulo stabil und deterministisch)
const ZOOM_SAMPLING = [
  { maxZoom: 4, step: 4 }, // 25 %
  { maxZoom: 6, step: 2 }, // 50 %
  { maxZoom: Infinity, step: 1 } // 100 %
];

// Optionen der Velocity-Layer für ein ruhiges Partikelfeld
const VELOCITY_OPTIONS = {
  maxVelocity: 25,
  velocityScale: 0.002,
  particleAge: 60,
  particleMultiplier: 1 / 400,
  frameRate: 20,
  lineWidth: 1,
  velocityType: '10m Wind',
  speedUnit: 'm/s'
};

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
    const velocityData = buildVelocityData(payload, map.getZoom());

    if (!velocityData) {
      updateInfoLabel(`Wind flow: ${REGION_SOURCES[regionKey]?.label ?? 'Region'} (Daten fehlerhaft)`);
      return;
    }

    const maxVelocity = payload?.meta?.stats?.maxVelocity ?? VELOCITY_OPTIONS.maxVelocity;
    const layerOptions = { ...VELOCITY_OPTIONS, maxVelocity, data: velocityData };

    if (velocityLayer && typeof velocityLayer.setData === 'function') {
      velocityLayer.setData(velocityData);
    } else {
      if (velocityLayer && map.hasLayer(velocityLayer)) {
        map.removeLayer(velocityLayer);
      }
      velocityLayer = L.velocityLayer(layerOptions);
      map.addLayer(velocityLayer);
    }

    const timeText = formatTimeUtc(payload.meta?.updatedAt ?? payload.generated);
    updateInfoLabel(`Wind flow: ${REGION_SOURCES[regionKey]?.label ?? 'Region'}${timeText ? ` (updated ${timeText} UTC)` : ''}`);
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
        if (!json) return null;
        const payload = {
          meta: json.meta ?? {},
          data: json.data ?? json.field ?? null,
          points: json.points ?? null,
          generated: json.meta?.generated ?? json.generated ?? null
        };
        payloadCache.set(regionKey, payload);
        return payload;
      })
      .catch((err) => {
        console.error('Winddaten konnten nicht geladen werden:', err);
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

  const directField = payload.data ?? payload.field;
  if (Array.isArray(directField) && directField.length) return directField;

  const sampledPoints = samplePointsForZoom(payload.points, zoom);
  if (!sampledPoints?.length) return null;

  const generated = payload.generated;

  // Grid aus vorhandenen Punkten ableiten; sortiert sorgt für deterministisches Mapping
  const lats = Array.from(new Set(sampledPoints.map((p) => Number(p.lat)))).sort((a, b) => b - a); // Nord -> Süd
  const lons = Array.from(new Set(sampledPoints.map((p) => Number(p.lon)))).sort((a, b) => a - b); // West -> Ost

  const latStep = lats.length > 1 ? Math.min(...diffs(lats.slice().reverse())) : 1;
  const lonStep = lons.length > 1 ? Math.min(...diffs(lons)) : 1;

  const nx = lons.length;
  const ny = lats.length;
  if (nx === 0 || ny === 0) return null;

  const u = new Array(nx * ny).fill(0);
  const v = new Array(nx * ny).fill(0);

  // Map für schnellen Zugriff
  const pointLookup = new Map();
  for (const p of sampledPoints) {
    const key = `${p.lat}:${p.lon}`;
    pointLookup.set(key, p);
  }

  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const lat = lats[y];
      const lon = lons[x];
      const idx = y * nx + x;
      const point = pointLookup.get(`${lat}:${lon}`);
      if (!point) continue;

      // Windrichtung in U/V (Richtung in Grad, meteorologisch: Richtung AUS der der Wind kommt)
      const speed = Number(point.speed) || 0;
      const dirRad = (Number(point.dir) || 0) * (Math.PI / 180);
      const uVal = -speed * Math.sin(dirRad);
      const vVal = -speed * Math.cos(dirRad);
      u[idx] = uVal;
      v[idx] = vVal;
    }
  }

  const baseHeader = {
    parameterCategory: 2,
    nx,
    ny,
    lo1: lons[0],
    lo2: lons[nx - 1],
    la1: lats[0],
    la2: lats[ny - 1],
    dx: lonStep,
    dy: latStep,
    refTime: generated || new Date().toISOString()
  };

  return [
    { header: { ...baseHeader, parameterNumber: 2 }, data: u },
    { header: { ...baseHeader, parameterNumber: 3 }, data: v }
  ];
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
