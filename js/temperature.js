const CITY_MODE_MAX_ZOOM = 6;
const LOCAL_MODE_MIN_ZOOM = 7;
const LOCAL_FETCH_DEBOUNCE_MS = 800;
const LOCAL_CACHE_MS = 10 * 60 * 1000;
const LOCAL_MOVE_THRESHOLD = 0.05; // deg (~5 km)
const GERMANY_BBOX = { latMin: 47.0, latMax: 55.0, lonMin: 5.5, lonMax: 15.5 };

let cityLayer = null;
let cityDataPromise = null;
let gridDataPromise = null;
let localMarker = null;
let localFetchTimer = null;
let lastLocalResult = null;
let attributionControl = null;

const isWithinGermany = (lat, lon, padding = 0) => {
  return (
    lat >= GERMANY_BBOX.latMin - padding &&
    lat <= GERMANY_BBOX.latMax + padding &&
    lon >= GERMANY_BBOX.lonMin - padding &&
    lon <= GERMANY_BBOX.lonMax + padding
  );
};

const toRad = deg => deg * Math.PI / 180;

export function getLocalTemperatureFromDwdGrid(lat, lon, gridPoints) {
  if (!Array.isArray(gridPoints) || !gridPoints.length) return null;
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  const latRad = toRad(lat);
  const lonRad = toRad(lon);
  gridPoints.forEach(point => {
    const dLat = toRad(point.lat) - latRad;
    const dLon = toRad(point.lon) - lonRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(latRad) * Math.cos(toRad(point.lat)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    const dist = 6371 * c;
    if (dist < bestDist) {
      bestDist = dist;
      best = point;
    }
  });
  return best ? { ...best, distanceKm: bestDist } : null;
}

const createTempIcon = (L, text, type = 'local') => {
  const className = type === 'city' ? 'temp-label temp-label--city' : 'temp-label temp-label--local';
  const icon = L.divIcon({
    className,
    html: `<div class="temp-label__inner">🌡 ${text}</div>`,
    iconSize: null,
  });
  return icon;
};

const ensureCityData = () => {
  if (!cityDataPromise) {
    cityDataPromise = fetch('/data/temperature-germany-cities.json', { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .catch(err => {
        console.warn('Städtetemperaturen (DWD) fehlgeschlagen:', err);
        return null;
      });
  }
  return cityDataPromise;
};

const ensureGridData = () => {
  if (!gridDataPromise) {
    gridDataPromise = fetch('/data/temperature-germany-grid.json', { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .catch(err => {
        console.warn('Temperatur-Grid (DWD) fehlgeschlagen:', err);
        return null;
      });
  }
  return gridDataPromise;
};

const ensureAttributionControl = (L, map) => {
  if (attributionControl) return attributionControl;
  attributionControl = L.control({ position: 'bottomleft' });
  attributionControl.onAdd = () => {
    const div = L.DomUtil.create('div', 'temp-source-note');
    div.textContent = 'Temperaturdaten: DWD (Messstationen), interpoliert.';
    return div;
  };
  return attributionControl;
};

export function renderCityTemperaturesForGermany(L, map, data) {
  if (!data?.cities?.length) return null;
  const layer = L.layerGroup();
  data.cities.forEach(city => {
    const label = `${city.name}: ${Number(city.temp).toFixed(1)} °C`;
    const marker = L.marker([city.lat, city.lon], {
      icon: createTempIcon(L, label, 'city'),
      interactive: false,
    });
    marker.addTo(layer);
  });
  layer.addTo(map);
  return layer;
}

const clearLocalLabel = map => {
  if (localMarker) {
    map.removeLayer(localMarker);
    localMarker = null;
  }
};

const clearCityLayer = map => {
  if (cityLayer) {
    map.removeLayer(cityLayer);
    cityLayer = null;
  }
};

const reuseLocalCache = (center, map) => {
  if (!lastLocalResult) return false;
  const age = Date.now() - lastLocalResult.fetchedAt;
  const movedFar =
    Math.abs(center.lat - lastLocalResult.lat) > LOCAL_MOVE_THRESHOLD ||
    Math.abs(center.lng - lastLocalResult.lon) > LOCAL_MOVE_THRESHOLD;
  if (age > LOCAL_CACHE_MS || movedFar) return false;
  showLocalTemperature(map, lastLocalResult.temp, center, lastLocalResult.sourceLabel);
  return true;
};

const showLocalTemperature = (map, temp, center, sourceLabel = null) => {
  const rounded = temp == null ? null : Number(temp).toFixed(1);
  const tempText = rounded == null || Number.isNaN(Number(rounded)) ? '–' : `${rounded} °C`;
  const stationText = sourceLabel ? ` (${sourceLabel})` : '';
  const text = `Aktuell: ${tempText}${stationText}`;
  const icon = createTempIcon(L, text, 'local');
  if (localMarker) {
    localMarker.setLatLng(center);
    localMarker.setIcon(icon);
  } else {
    localMarker = L.marker(center, { icon, interactive: false }).addTo(map);
  }
};

const fetchLocalTemperatureFromOpenMeteo = async center => {
  const params = new URLSearchParams({
    latitude: center.lat.toFixed(3),
    longitude: center.lng.toFixed(3),
    current: 'temperature_2m',
    timezone: 'UTC',
  });
  const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const temp = data?.current?.temperature_2m;
  if (!Number.isFinite(Number(temp))) throw new Error('Open-Meteo ohne Temperatur');
  return { temp: Number(temp), sourceLabel: 'Open-Meteo' };
};

const fetchLocalTemperature = async (map, center) => {
  let result = null;
  try {
    const gridData = await ensureGridData();
    const gridPoints = gridData?.points;
    if (Array.isArray(gridPoints) && gridPoints.length) {
      const nearest = getLocalTemperatureFromDwdGrid(center.lat, center.lng, gridPoints);
      if (nearest) {
        const sourceLabel = nearest.station_name ? `DWD, Station ${nearest.station_name}` : 'DWD';
        result = { temp: nearest.temp, sourceLabel };
      }
    }
  } catch (err) {
    console.warn('DWD-Temperatur-Grid fehlgeschlagen, fallback Open-Meteo:', err);
  }

  if (!result) {
    console.warn('Keine DWD-Temperaturdaten gefunden, nutze Open-Meteo.');
    result = await fetchLocalTemperatureFromOpenMeteo(center);
  }

  lastLocalResult = {
    lat: center.lat,
    lon: center.lng,
    temp: result.temp,
    sourceLabel: result.sourceLabel,
    fetchedAt: Date.now(),
  };
  showLocalTemperature(map, result.temp, center, result.sourceLabel);
};

const updateLocal = map => {
  const center = map.getCenter();
  if (reuseLocalCache(center, map)) return;
  showLocalTemperature(map, '…', center, null);
  fetchLocalTemperature(map, center).catch(err => {
    console.warn('Lokale Temperatur fehlgeschlagen:', err);
    showLocalTemperature(map, null, center, null);
  });
};

const scheduleLocalUpdate = map => {
  clearTimeout(localFetchTimer);
  localFetchTimer = setTimeout(() => updateLocal(map), LOCAL_FETCH_DEBOUNCE_MS);
};

const switchToCityMode = async (L, map) => {
  clearTimeout(localFetchTimer);
  clearLocalLabel(map);
  if (cityLayer) return cityLayer;
  const data = await ensureCityData();
  if (!data) return null;
  cityLayer = renderCityTemperaturesForGermany(L, map, data);
  return cityLayer;
};

const switchToLocalMode = map => {
  clearCityLayer(map);
  scheduleLocalUpdate(map);
};

export async function updateTemperatureOverlay(L, map) {
  const center = map.getCenter();
  const zoom = map.getZoom();
  const inGermany = isWithinGermany(center.lat, center.lng, 0.2);

  const control = ensureAttributionControl(L, map);
  if (inGermany) {
    if (!control._map) control.addTo(map);
  } else if (control._map) {
    control.remove();
  }

  if (!inGermany) {
    clearTimeout(localFetchTimer);
    clearLocalLabel(map);
    clearCityLayer(map);
    return;
  }

  if (zoom >= LOCAL_MODE_MIN_ZOOM) {
    switchToLocalMode(map);
  } else if (zoom <= CITY_MODE_MAX_ZOOM) {
    await switchToCityMode(L, map);
  } else {
    await switchToCityMode(L, map);
  }
}

export function bindTemperature(L, map) {
  map.on('zoomend moveend', () => updateTemperatureOverlay(L, map));
  updateTemperatureOverlay(L, map);
}

export const __temperatureTestInternals = {
  CITY_MODE_MAX_ZOOM,
  LOCAL_MODE_MIN_ZOOM,
  LOCAL_FETCH_DEBOUNCE_MS,
  LOCAL_CACHE_MS,
  LOCAL_MOVE_THRESHOLD,
  isWithinGermany,
  getLocalTemperatureFromDwdGrid,
};
