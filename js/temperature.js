const CITY_MODE_MAX_ZOOM = 6;
const LOCAL_MODE_MIN_ZOOM = 7;
const LOCAL_FETCH_DEBOUNCE_MS = 800;
const LOCAL_CACHE_MS = 10 * 60 * 1000;
const LOCAL_MOVE_THRESHOLD = 0.05; // deg (~5 km)

let cityLayer = null;
let cityDataPromise = null;
let localMarker = null;
let localFetchTimer = null;
let lastLocalResult = null;

/**
 * Binds temperature rendering to a Leaflet map.
 * - Shows city temperatures when zoomed out
 * - Shows a single local temperature near the map center when zoomed in
 */
export function bindTemperature(L, map) {
  const ensureCityData = () => {
    if (!cityDataPromise) {
      cityDataPromise = fetch('/data/temperature-cities.json', { cache: 'no-store' })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .catch(err => {
          console.warn('Städtetemperaturen fehlgeschlagen:', err);
          return null;
        });
    }
    return cityDataPromise;
  };

  const clearLocalLabel = () => {
    if (localMarker) {
      map.removeLayer(localMarker);
      localMarker = null;
    }
  };

  const clearCityLayer = () => {
    if (cityLayer) {
      map.removeLayer(cityLayer);
      cityLayer = null;
    }
  };

  const createTempIcon = (text, type = 'local') => {
    const className = type === 'city' ? 'temp-label temp-label--city' : 'temp-label temp-label--local';
    const icon = L.divIcon({
      className,
      html: `<div class="temp-label__inner">🌡 ${text}</div>`,
      iconSize: null,
    });
    return icon;
  };

  const renderCities = async () => {
    const data = await ensureCityData();
    if (!data?.cities?.length) return;
    if (cityLayer) return; // already rendered
    cityLayer = L.layerGroup();
    data.cities.forEach(city => {
      const label = `${city.name}: ${Number(city.temp).toFixed(1)} °C`;
      const marker = L.marker([city.lat, city.lon], {
        icon: createTempIcon(label, 'city'),
        interactive: false,
      });
      marker.addTo(cityLayer);
    });
    cityLayer.addTo(map);
  };

  const reuseLocalCache = center => {
    if (!lastLocalResult) return false;
    const age = Date.now() - lastLocalResult.fetchedAt;
    const movedFar =
      Math.abs(center.lat - lastLocalResult.lat) > LOCAL_MOVE_THRESHOLD ||
      Math.abs(center.lng - lastLocalResult.lon) > LOCAL_MOVE_THRESHOLD;
    if (age > LOCAL_CACHE_MS || movedFar) return false;
    showLocalTemperature(lastLocalResult.temp, center);
    return true;
  };

  const showLocalTemperature = (temp, center) => {
    const rounded = temp == null ? null : Number(temp).toFixed(1);
    const text = rounded == null || Number.isNaN(Number(rounded))
      ? 'Aktuell: –'
      : `Aktuell: ${rounded} °C`;
    const icon = createTempIcon(text, 'local');
    if (localMarker) {
      localMarker.setLatLng(center);
      localMarker.setIcon(icon);
    } else {
      localMarker = L.marker(center, { icon, interactive: false }).addTo(map);
    }
  };

  const fetchLocalTemperature = async center => {
    const params = new URLSearchParams({
      lat: center.lat.toFixed(3),
      lon: center.lng.toFixed(3),
    });
    const res = await fetch(`/api/temperature?${params.toString()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const temp = data?.temperature ?? data?.temp ?? data?.value;
    if (temp == null) throw new Error('Keine Temperatur im Backend');
    lastLocalResult = { lat: center.lat, lon: center.lng, temp, fetchedAt: Date.now() };
    showLocalTemperature(temp, center);
  };

  const updateLocal = () => {
    const center = map.getCenter();
    if (reuseLocalCache(center)) return;
    showLocalTemperature('…', center);
    fetchLocalTemperature(center).catch(err => {
      console.warn('Lokale Temperatur fehlgeschlagen:', err);
      showLocalTemperature(null, center);
    });
  };

  const scheduleLocalUpdate = () => {
    clearTimeout(localFetchTimer);
    localFetchTimer = setTimeout(updateLocal, LOCAL_FETCH_DEBOUNCE_MS);
  };

  const switchToCityMode = () => {
    clearTimeout(localFetchTimer);
    clearLocalLabel();
    renderCities();
  };

  const switchToLocalMode = () => {
    clearCityLayer();
    scheduleLocalUpdate();
  };

  const handleViewportChange = () => {
    const zoom = map.getZoom();
    if (zoom >= LOCAL_MODE_MIN_ZOOM) {
      switchToLocalMode();
    } else if (zoom <= CITY_MODE_MAX_ZOOM) {
      switchToCityMode();
    } else {
      // In-between range: keep city mode to avoid spamming local fetches
      switchToCityMode();
    }
  };

  map.on('zoomend moveend', handleViewportChange);
  handleViewportChange();
}

export const __temperatureTestInternals = {
  CITY_MODE_MAX_ZOOM,
  LOCAL_MODE_MIN_ZOOM,
  LOCAL_FETCH_DEBOUNCE_MS,
  LOCAL_CACHE_MS,
  LOCAL_MOVE_THRESHOLD,
};
