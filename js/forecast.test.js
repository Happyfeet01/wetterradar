import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  __test,
  buildForecastUrl,
  buildGeocodingUrl,
  bindForecast,
  fetchForecast,
  normalizeForecast,
  renderForecastHtml,
  searchLocation,
  weatherCodeMeta,
} from './forecast.js';

const fixture = {
  timezone: 'Europe/Berlin',
  current: {
    time: '2026-09-19T09:00',
    temperature_2m: 16.4,
    apparent_temperature: 15.2,
    weather_code: 61,
    wind_speed_10m: 12.3,
    wind_direction_10m: 225,
    wind_gusts_10m: 28.5,
    precipitation: 0.2,
  },
  daily: {
    time: ['2026-09-19', '2026-09-20'],
    weather_code: [61, 2],
    temperature_2m_max: [18.2, 20.6],
    temperature_2m_min: [10.1, 9.4],
    precipitation_probability_max: [70, 10],
    precipitation_sum: [4.2, 0],
    wind_gusts_10m_max: [36.4, 22.1],
  },
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __test.clearCache();
});

describe('DWD ICON point forecast', () => {
  it('builds an explicit five-day, coordinate-based request', () => {
    const url = new URL(buildForecastUrl(50.423, 9.565));
    assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/dwd-icon');
    assert.equal(url.searchParams.get('latitude'), '50.4230');
    assert.equal(url.searchParams.get('longitude'), '9.5650');
    assert.equal(url.searchParams.get('forecast_days'), '5');
    assert.match(url.searchParams.get('daily'), /precipitation_probability_max/);
  });

  it('normalizes current conditions and aligned daily values', () => {
    const forecast = normalizeForecast(fixture);
    assert.equal(forecast.timezone, 'Europe/Berlin');
    assert.equal(forecast.current.temperature, 16.4);
    assert.equal(forecast.days.length, 2);
    assert.deepEqual(forecast.days[1], {
      date: '2026-09-20',
      weatherCode: 2,
      tempMax: 20.6,
      tempMin: 9.4,
      precipitationProbability: 10,
      precipitation: 0,
      gusts: 22.1,
    });
  });

  it('maps weather codes and escapes the location label in rendered HTML', () => {
    assert.equal(weatherCodeMeta(95).label, 'Gewitter');
    const html = renderForecastHtml(normalizeForecast(fixture), '<Flieden & Umgebung>', 50.42, 9.56);
    assert.match(html, /&lt;Flieden &amp; Umgebung&gt;/);
    assert.doesNotMatch(html, /<Flieden/);
    assert.match(html, /DWD ICON Global\/EU\/D2/);
  });

  it('caches repeated requests at the same rounded coordinate for 15 minutes', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, json: async () => fixture };
    };

    const first = await fetchForecast(50.42341, 9.56541, { now: 1_000 });
    const second = await fetchForecast(50.42349, 9.56549, { now: 2_000 });
    assert.equal(calls, 1);
    assert.strictEqual(first, second);
  });

  it('geocodes only the submitted search query and returns its first result', async () => {
    let requestedUrl = '';
    globalThis.fetch = async url => {
      requestedUrl = String(url);
      return {
        ok: true,
        json: async () => [{ lat: '50.423', lon: '9.565', display_name: 'Flieden, Landkreis Fulda' }],
      };
    };

    const location = await searchLocation('Flieden');
    assert.deepEqual(location, { lat: 50.423, lon: 9.565, label: 'Flieden, Landkreis Fulda' });
    assert.equal(new URL(requestedUrl).searchParams.get('q'), 'Flieden');
    assert.match(buildGeocodingUrl('36103 Flieden'), /36103\+Flieden/);
  });

  it('does not request a forecast while binding or moving the map', () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, json: async () => fixture };
    };
    const mapHandlers = {};
    const map = {
      on: (event, handler) => { mapHandlers[event] = handler; },
    };
    const ui = {
      locationSearch: { addEventListener() {} },
      txtLocationSearch: {},
      lblLocationSearch: {
        textContent: '',
        classList: { toggle() {} },
      },
    };

    bindForecast({}, map, ui);
    assert.equal(calls, 0);
    assert.equal(typeof mapHandlers.click, 'function');
    assert.equal(typeof mapHandlers.dblclick, 'function');
    assert.equal(mapHandlers.moveend, undefined);
    assert.equal(mapHandlers.zoomend, undefined);
  });
});
