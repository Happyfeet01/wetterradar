#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const fetchFn = globalThis.fetch
  ? (...args) => globalThis.fetch(...args)
  : async (...args) => {
      const { default: fetch } = await import('node-fetch');
      return fetch(...args);
    };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, 'wind');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'current.json');

const clampNumber = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const bounds = {
  north: clampNumber(process.env.WIND_LAT_MAX, 56.0),
  south: clampNumber(process.env.WIND_LAT_MIN, 46.0),
  west: clampNumber(process.env.WIND_LON_MIN, 5.0),
  east: clampNumber(process.env.WIND_LON_MAX, 16.0)
};

if (bounds.north <= bounds.south) {
  throw new Error('WIND_LAT_MAX must be larger than WIND_LAT_MIN');
}
if (bounds.east <= bounds.west) {
  throw new Error('WIND_LON_MAX must be larger than WIND_LON_MIN');
}

const latStep = clampNumber(process.env.WIND_LAT_STEP, 2.0) || 2.0;
const lonStep = clampNumber(process.env.WIND_LON_STEP, 2.0) || 2.0;
const refreshMinutes = Math.max(5, clampNumber(process.env.WIND_REFRESH_MINUTES, 180) || 180);
const requestDelayMs = Math.max(0, clampNumber(process.env.WIND_REQUEST_DELAY_MS, 150) || 0);

const apiBase = process.env.WIND_API_URL ?? 'https://api.open-meteo.com/v1/gfs';
const hourlyParams = process.env.WIND_API_PARAMS ?? 'wind_speed_10m,wind_direction_10m';
const apiTimezone = process.env.WIND_API_TZ ?? 'UTC';
const apiForecastDays = clampNumber(process.env.WIND_API_FORECAST_DAYS, 1) || 1;

const coordinatePrecision = clampNumber(process.env.WIND_COORD_PRECISION, 3) || 3;

const toFixed = (value) => Number(value.toFixed(coordinatePrecision));

function buildLatitudeArray() {
  const values = [];
  for (let lat = bounds.north; lat >= bounds.south - 1e-6; lat -= latStep) {
    values.push(toFixed(lat));
  }
  return values;
}

function buildLongitudeArray() {
  const values = [];
  for (let lon = bounds.west; lon <= bounds.east + 1e-6; lon += lonStep) {
    values.push(toFixed(lon));
  }
  return values;
}

const latitudes = buildLatitudeArray();
const longitudes = buildLongitudeArray();
const totalPoints = latitudes.length * longitudes.length;

if (!totalPoints) {
  throw new Error('Wind grid is empty – adjust bounds/steps');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toIso(timeString) {
  if (!timeString) return null;
  try {
    return new Date(timeString.endsWith('Z') ? timeString : `${timeString}Z`).toISOString();
  } catch {
    return timeString;
  }
}

function toVector(speed, directionDeg) {
  const speedMs = Number(speed);
  const dir = Number(directionDeg);
  if (!Number.isFinite(speedMs) || !Number.isFinite(dir)) {
    throw new Error('Ungültige Windkomponenten');
  }
  const rad = (dir * Math.PI) / 180;
  const u = -speedMs * Math.sin(rad);
  const v = -speedMs * Math.cos(rad);
  return {
    u: Math.round(u * 1000) / 1000,
    v: Math.round(v * 1000) / 1000
  };
}

async function fetchPoint(lat, lon, targetTime) {
  const url = new URL(apiBase);
  url.searchParams.set('latitude', lat.toFixed(3));
  url.searchParams.set('longitude', lon.toFixed(3));
  url.searchParams.set('hourly', hourlyParams);
  url.searchParams.set('forecast_days', String(apiForecastDays));
  url.searchParams.set('timezone', apiTimezone);
  url.searchParams.set('windspeed_unit', 'ms');
  url.searchParams.set('past_days', '0');

  const res = await fetchFn(url, { cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Open-Meteo ${res.status} ${res.statusText}: ${text.slice(0, 160)}`);
  }
  const json = await res.json();
  const times = json?.hourly?.time;
  const speeds = json?.hourly?.wind_speed_10m;
  const dirs = json?.hourly?.wind_direction_10m;

  if (!Array.isArray(times) || !Array.isArray(speeds) || !Array.isArray(dirs)) {
    throw new Error('Antwort ohne stündliche Winddaten');
  }

  let index = 0;
  if (targetTime) {
    const found = times.indexOf(targetTime);
    if (found >= 0) {
      index = found;
    }
  }

  const speed = speeds[index];
  const direction = dirs[index];
  if (speed == null || direction == null) {
    throw new Error('Winddaten fehlen (NaN)');
  }

  const { u, v } = toVector(speed, direction);
  return { u, v, datasetTime: times[index] };
}

function buildHeaders(datasetTimeIso) {
  const base = {
    parameterCategory: 2,
    parameterUnit: 'm.s-1',
    refTime: datasetTimeIso,
    lo1: longitudes[0],
    la1: latitudes[0],
    lo2: longitudes[longitudes.length - 1],
    la2: latitudes[latitudes.length - 1],
    nx: longitudes.length,
    ny: latitudes.length,
    dx: lonStep,
    dy: latStep,
    scanMode: 0
  };
  return [
    { ...base, parameterNumber: 2 },
    { ...base, parameterNumber: 3 }
  ];
}

async function ensureOutputDir() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

async function writeJson(filePath, payload) {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2));
  await fs.rename(tmpPath, filePath);
}

async function buildField() {
  const uData = [];
  const vData = [];
  let datasetTime = null;

  let idx = 0;
  for (const lat of latitudes) {
    for (const lon of longitudes) {
      const point = await fetchPoint(lat, lon, datasetTime);
      if (!datasetTime) {
        datasetTime = point.datasetTime;
      }
      uData[idx] = point.u;
      vData[idx] = point.v;
      idx += 1;
      if (requestDelayMs) {
        await sleep(requestDelayMs);
      }
    }
  }

  const datasetTimeIso = toIso(datasetTime) ?? new Date().toISOString();
  const headers = buildHeaders(datasetTimeIso);
  const magnitude = uData.map((u, i) => Math.hypot(u, vData[i]));
  const maxVelocity = magnitude.reduce((acc, value) => (value > acc ? value : acc), 0);
  const avgVelocity = magnitude.reduce((acc, value) => acc + value, 0) / magnitude.length;

  const payload = {
    meta: {
      generated: new Date().toISOString(),
      datasetTime: datasetTimeIso,
      refreshMinutes,
      source: 'Open-Meteo GFS (10 m Wind)',
      api: apiBase,
      bounds,
      grid: {
        latitudeStep: latStep,
        longitudeStep: lonStep,
        nx: longitudes.length,
        ny: latitudes.length,
        points: totalPoints
      },
      stats: {
        maxVelocity: Math.round(maxVelocity * 1000) / 1000,
        avgVelocity: Math.round(avgVelocity * 1000) / 1000
      }
    },
    data: [
      { header: headers[0], data: uData },
      { header: headers[1], data: vData }
    ]
  };

  return payload;
}

async function updateOnce() {
  console.log(
    `[wind] Aktualisiere Feld (${latitudes.length}×${longitudes.length} Raster, ${totalPoints} Punkte)...`
  );
  const payload = await buildField();
  await ensureOutputDir();
  await writeJson(OUTPUT_FILE, payload);
  console.log(
    `[wind] ${OUTPUT_FILE} aktualisiert – Zeitstempel ${payload.meta.datasetTime}, max ${payload.meta.stats.maxVelocity} m/s`
  );
}

async function main() {
  const runOnce = process.argv.includes('--once');
  try {
    await updateOnce();
  } catch (err) {
    console.error('[wind] Aktualisierung fehlgeschlagen:', err);
  }
  if (runOnce) {
    return;
  }
  const intervalMs = refreshMinutes * 60 * 1000;
  console.log(`[wind] Warte ${refreshMinutes} Minuten bis zur nächsten Aktualisierung...`);
  setInterval(async () => {
    try {
      await updateOnce();
    } catch (err) {
      console.error('[wind] Aktualisierung fehlgeschlagen:', err);
    }
  }, intervalMs);
}

main().catch((err) => {
  console.error('[wind] Nicht behandelter Fehler:', err);
  process.exitCode = 1;
});

process.on('SIGINT', () => {
  console.log('\n[wind] Beende auf Benutzerwunsch.');
  process.exit(0);
});
