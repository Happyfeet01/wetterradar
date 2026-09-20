const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/dwd-icon';
const GEOCODING_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const CACHE_MS = 15 * 60 * 1000;

const forecastCache = new Map();

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function weatherCodeMeta(code) {
  const numericCode = Number(code);
  if (numericCode === 0) return { icon: '☀️', label: 'Klar' };
  if ([1, 2].includes(numericCode)) return { icon: '🌤️', label: 'Leicht bewölkt' };
  if (numericCode === 3) return { icon: '☁️', label: 'Bedeckt' };
  if ([45, 48].includes(numericCode)) return { icon: '🌫️', label: 'Nebel' };
  if ([51, 53, 55, 56, 57].includes(numericCode)) return { icon: '🌦️', label: 'Nieselregen' };
  if ([61, 63, 65, 66, 67].includes(numericCode)) return { icon: '🌧️', label: 'Regen' };
  if ([71, 73, 75, 77].includes(numericCode)) return { icon: '🌨️', label: 'Schnee' };
  if ([80, 81, 82].includes(numericCode)) return { icon: '🌦️', label: 'Regenschauer' };
  if ([85, 86].includes(numericCode)) return { icon: '🌨️', label: 'Schneeschauer' };
  if ([95, 96, 99].includes(numericCode)) return { icon: '⛈️', label: 'Gewitter' };
  return { icon: '🌡️', label: 'Unbekannt' };
}

export function buildForecastUrl(lat, lon) {
  const params = new URLSearchParams({
    latitude: Number(lat).toFixed(4),
    longitude: Number(lon).toFixed(4),
    current: [
      'temperature_2m',
      'apparent_temperature',
      'weather_code',
      'wind_speed_10m',
      'wind_direction_10m',
      'wind_gusts_10m',
      'precipitation',
    ].join(','),
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_probability_max',
      'precipitation_sum',
      'wind_gusts_10m_max',
    ].join(','),
    timezone: 'auto',
    forecast_days: '5',
  });
  return `${FORECAST_ENDPOINT}?${params}`;
}

export function buildGeocodingUrl(query) {
  const params = new URLSearchParams({
    q: String(query).trim(),
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
    'accept-language': 'de',
  });
  return `${GEOCODING_ENDPOINT}?${params}`;
}

export function normalizeForecast(data) {
  const daily = data?.daily;
  if (!daily || !Array.isArray(daily.time) || daily.time.length === 0) {
    throw new Error('Die DWD-ICON-Antwort enthält keine Tagesprognose.');
  }

  const days = daily.time.slice(0, 5).map((date, index) => ({
    date,
    weatherCode: numberOrNull(daily.weather_code?.[index]),
    tempMax: numberOrNull(daily.temperature_2m_max?.[index]),
    tempMin: numberOrNull(daily.temperature_2m_min?.[index]),
    precipitationProbability: numberOrNull(daily.precipitation_probability_max?.[index]),
    precipitation: numberOrNull(daily.precipitation_sum?.[index]),
    gusts: numberOrNull(daily.wind_gusts_10m_max?.[index]),
  }));

  return {
    current: {
      time: data?.current?.time ?? null,
      weatherCode: numberOrNull(data?.current?.weather_code),
      temperature: numberOrNull(data?.current?.temperature_2m),
      apparentTemperature: numberOrNull(data?.current?.apparent_temperature),
      windSpeed: numberOrNull(data?.current?.wind_speed_10m),
      windDirection: numberOrNull(data?.current?.wind_direction_10m),
      gusts: numberOrNull(data?.current?.wind_gusts_10m),
      precipitation: numberOrNull(data?.current?.precipitation),
    },
    days,
    timezone: data?.timezone ?? null,
  };
}

const formatNumber = (value, digits = 0) => Number.isFinite(value)
  ? value.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : '–';

const formatDay = (isoDate, index) => {
  if (index === 0) return 'Heute';
  const date = new Date(`${isoDate}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? isoDate
    : new Intl.DateTimeFormat('de-DE', { weekday: 'short' }).format(date);
};

export function renderForecastHtml(forecast, placeLabel, lat, lon) {
  const currentMeta = weatherCodeMeta(forecast.current.weatherCode);
  const days = forecast.days.map((day, index) => {
    const meta = weatherCodeMeta(day.weatherCode);
    return `
      <li class="forecast-day">
        <span class="forecast-day__name">${escapeHtml(formatDay(day.date, index))}</span>
        <span class="forecast-day__icon" title="${escapeHtml(meta.label)}" aria-label="${escapeHtml(meta.label)}">${meta.icon}</span>
        <span class="forecast-day__temp">${formatNumber(day.tempMax)}° / ${formatNumber(day.tempMin)}°</span>
        <span class="forecast-day__rain">💧 ${formatNumber(day.precipitationProbability)} % · ${formatNumber(day.precipitation, 1)} mm</span>
        <span class="forecast-day__gusts">💨 ${formatNumber(day.gusts)} km/h</span>
      </li>`;
  }).join('');

  return `
    <section class="forecast-card" aria-label="DWD-Wetterprognose für ${escapeHtml(placeLabel)}">
      <header class="forecast-card__header">
        <div><strong>${escapeHtml(placeLabel)}</strong><small>${Number(lat).toFixed(3)}, ${Number(lon).toFixed(3)}</small></div>
        <span class="forecast-card__current-icon" title="${escapeHtml(currentMeta.label)}">${currentMeta.icon}</span>
        <strong class="forecast-card__temperature">${formatNumber(forecast.current.temperature, 1)} °C</strong>
      </header>
      <div class="forecast-card__current">
        ${escapeHtml(currentMeta.label)} · gefühlt ${formatNumber(forecast.current.apparentTemperature, 1)} °C<br>
        Wind ${formatNumber(forecast.current.windSpeed)} km/h, Böen ${formatNumber(forecast.current.gusts)} km/h
      </div>
      <ul class="forecast-days">${days}</ul>
      <footer>DWD ICON Global/EU/D2 · bereitgestellt via Open-Meteo</footer>
    </section>`;
}

async function fetchJson(url, { signal } = {}) {
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function fetchForecast(lat, lon, { signal, now = Date.now() } = {}) {
  const key = `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
  const cached = forecastCache.get(key);
  if (cached && now - cached.fetchedAt < CACHE_MS) return cached.forecast;

  const forecast = normalizeForecast(await fetchJson(buildForecastUrl(lat, lon), { signal }));
  forecastCache.set(key, { forecast, fetchedAt: now });
  return forecast;
}

export async function searchLocation(query, { signal } = {}) {
  const results = await fetchJson(buildGeocodingUrl(query), { signal });
  const result = Array.isArray(results) ? results[0] : null;
  const lat = numberOrNull(result?.lat);
  const lon = numberOrNull(result?.lon);
  if (!result || lat == null || lon == null) throw new Error('Ort nicht gefunden.');
  return { lat, lon, label: result.display_name || String(query).trim() };
}

export function bindForecast(L, map, ui) {
  if (!ui?.locationSearch || !ui?.txtLocationSearch) return;

  let marker = null;
  let forecastController = null;
  let searchController = null;
  let mapClickTimer = null;

  const setSearchState = (message = '', isError = false) => {
    if (!ui.lblLocationSearch) return;
    ui.lblLocationSearch.textContent = message;
    ui.lblLocationSearch.classList.toggle('is-error', isError);
  };

  const showForecast = async (lat, lon, label, { center = false } = {}) => {
    forecastController?.abort();
    forecastController = new AbortController();
    const latLng = [lat, lon];
    if (center) map.setView(latLng, Math.max(map.getZoom(), 10));
    if (!marker) {
      marker = L.marker(latLng, { title: 'DWD-Wetterprognose' }).addTo(map);
    } else {
      marker.setLatLng(latLng);
    }
    marker.bindPopup('<div class="forecast-loading">DWD-Prognose wird geladen…</div>', {
      minWidth: 290,
      maxWidth: 520,
      className: 'forecast-popup',
    }).openPopup();
    setSearchState('DWD-Prognose wird geladen…');

    try {
      const forecast = await fetchForecast(lat, lon, { signal: forecastController.signal });
      marker.setPopupContent(renderForecastHtml(forecast, label, lat, lon));
      marker.openPopup();
      setSearchState('');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.warn('DWD-Prognose konnte nicht geladen werden:', error);
      marker.setPopupContent('<div class="forecast-error">Die DWD-Prognose ist momentan nicht verfügbar.</div>');
      marker.openPopup();
      setSearchState('Prognose nicht verfügbar', true);
    }
  };

  ui.locationSearch.addEventListener('submit', async event => {
    event.preventDefault();
    const query = ui.txtLocationSearch.value.trim();
    if (!query) {
      setSearchState('Bitte einen Ort eingeben.', true);
      ui.txtLocationSearch.focus();
      return;
    }

    searchController?.abort();
    searchController = new AbortController();
    const activeSearchController = searchController;
    if (ui.btnLocationSearch) ui.btnLocationSearch.disabled = true;
    setSearchState('Ort wird gesucht…');
    try {
      const location = await searchLocation(query, { signal: activeSearchController.signal });
      await showForecast(location.lat, location.lon, location.label, { center: true });
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.warn('Ortssuche fehlgeschlagen:', error);
      setSearchState(error?.message === 'Ort nicht gefunden.' ? error.message : 'Ortssuche nicht verfügbar', true);
    } finally {
      if (ui.btnLocationSearch && searchController === activeSearchController) ui.btnLocationSearch.disabled = false;
    }
  });

  map.on('click', event => {
    const target = event.originalEvent?.target;
    if (target?.closest?.('.leaflet-control, .leaflet-marker-icon, .leaflet-interactive')) return;
    const { lat, lng: lon } = event.latlng;
    clearTimeout(mapClickTimer);
    mapClickTimer = setTimeout(() => {
      void showForecast(lat, lon, 'Ausgewählter Kartenpunkt');
    }, 300);
  });
  map.on('dblclick', () => clearTimeout(mapClickTimer));
}

export const __test = {
  clearCache: () => forecastCache.clear(),
};
