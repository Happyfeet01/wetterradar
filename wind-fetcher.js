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
const OUTPUT_DIR = process.env.WIND_OUTPUT_DIR ?? '/var/www/wetterradar/wind';
const CURRENT_FILE = path.join(OUTPUT_DIR, 'current.json');
const LAST_SUCCESS_FILE = path.join(OUTPUT_DIR, 'last-success.json');
const TEMP_FILE = path.join(OUTPUT_DIR, 'current.tmp.json');
const LOCK_FILE = path.join(OUTPUT_DIR, 'wind.lock');

const CACHE_INTERVAL_HOURS = 12;
const CACHE_INTERVAL_MS = CACHE_INTERVAL_HOURS * 60 * 60 * 1000;

const clampNumber = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const bounds = {
  north: clampNumber(process.env.WIND_LAT_MAX, 72.0),
  south: clampNumber(process.env.WIND_LAT_MIN, 33.0),
  west: clampNumber(process.env.WIND_LON_MIN, -12.0),
  east: clampNumber(process.env.WIND_LON_MAX, 33.0)
};

if (bounds.north <= bounds.south) {
  throw new Error('WIND_LAT_MAX must be larger than WIND_LAT_MIN');
}
if (bounds.east <= bounds.west) {
  throw new Error('WIND_LON_MAX must be larger than WIND_LON_MIN');
}

const latStep = clampNumber(process.env.WIND_LAT_STEP, 2.0) || 2.0;
const lonStep = clampNumber(process.env.WIND_LON_STEP, 2.0) || 2.0;
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

async function ensureOutputDir() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function log(msg) {
  console.log(`[wind] ${msg}`);
}

function warn(msg) {
  console.warn(`[wind] ${msg}`);
}

async function acquireLock() {
  try {
    const handle = await fs.open(LOCK_FILE, 'wx');
    await handle.writeFile(`${process.pid}\n`);
    return async () => {
      await handle.close();
      await fs.unlink(LOCK_FILE).catch(() => {});
    };
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error('Lockfile exists – another instance is running');
    }
    throw err;
  }
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function restoreFallbackIfNeeded() {
  const hasCurrent = await fileExists(CURRENT_FILE);
  const hasLastSuccess = await fileExists(LAST_SUCCESS_FILE);

  if (!hasCurrent && hasLastSuccess) {
    try {
      const json = await readJson(LAST_SUCCESS_FILE);
      const restored = {
        ...json,
        generated: json.generated ?? json?.meta?.generated ?? new Date().toISOString(),
        interval_hours: CACHE_INTERVAL_HOURS,
        source: 'Open-Meteo (cached, fallback-enabled)',
        status: 'fallback'
      };
      await fs.writeFile(TEMP_FILE, JSON.stringify(restored, null, 2));
      await fs.rename(TEMP_FILE, CURRENT_FILE);
      log('Restored current cache from last successful run');
      log('Fallback restored');
    } catch (err) {
      warn(`Failed to restore fallback: ${err.message}`);
    }
  }
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
  if (res.status === 429) {
    const error = new Error('Open-Meteo HTTP 429');
    error.http429 = true;
    throw error;
  }
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

function collectStats(uData, vData) {
  const magnitudes = [];
  for (let i = 0; i < uData.length; i += 1) {
    const u = uData[i];
    const v = vData[i];
    if (typeof u === 'number' && typeof v === 'number') {
      magnitudes.push(Math.hypot(u, v));
    }
  }
  const maxVelocity = magnitudes.reduce((acc, value) => (value > acc ? value : acc), 0);
  const avgVelocity = magnitudes.length
    ? magnitudes.reduce((acc, value) => acc + value, 0) / magnitudes.length
    : 0;
  return {
    maxVelocity: Math.round(maxVelocity * 1000) / 1000,
    avgVelocity: Math.round(avgVelocity * 1000) / 1000
  };
}

async function buildField() {
  const uData = [];
  const vData = [];
  let datasetTime = null;
  let idx = 0;
  let successCount = 0;
  let failureCount = 0;

  for (const lat of latitudes) {
    for (const lon of longitudes) {
      try {
        const point = await fetchPoint(lat, lon, datasetTime);
        if (!datasetTime) {
          datasetTime = point.datasetTime;
        }
        uData[idx] = point.u;
        vData[idx] = point.v;
        successCount += 1;
      } catch (err) {
        if (err?.http429) {
          err.global429 = true;
          throw err;
        }
        uData[idx] = null;
        vData[idx] = null;
        failureCount += 1;
      }
      idx += 1;
      if (requestDelayMs) {
        await sleep(requestDelayMs);
      }
    }
  }

  const datasetTimeIso = toIso(datasetTime) ?? new Date().toISOString();
  const headers = buildHeaders(datasetTimeIso);
  const stats = collectStats(uData, vData);

  const generatedNow = new Date().toISOString();

  const payload = {
    generated: generatedNow,
    interval_hours: CACHE_INTERVAL_HOURS,
    source: 'Open-Meteo (cached, fallback-enabled)',
    status: 'ok',
    meta: {
      generated: generatedNow,
      datasetTime: datasetTimeIso,
      refreshMinutes: CACHE_INTERVAL_HOURS * 60,
      source: 'Open-Meteo (cached, fallback-enabled)',
      api: apiBase,
      bounds,
      grid: {
        latitudeStep: latStep,
        longitudeStep: lonStep,
        nx: longitudes.length,
        ny: latitudes.length,
        points: totalPoints
      },
      stats
    },
    data: [
      { header: headers[0], data: uData },
      { header: headers[1], data: vData }
    ],
    points: [
      { header: headers[0], data: uData },
      { header: headers[1], data: vData }
    ]
  };

  return { payload, successCount, failureCount };
}

async function cacheAgeMs() {
  if (!(await fileExists(CURRENT_FILE))) return null;
  try {
    const json = await readJson(CURRENT_FILE);
    const generated = json?.generated ?? json?.meta?.generated;
    const parsed = generated ? Date.parse(generated) : NaN;
    if (Number.isFinite(parsed)) {
      return Date.now() - parsed;
    }
  } catch {
    // ignore JSON errors and fall back to file stats
  }
  try {
    const stat = await fs.stat(CURRENT_FILE);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

async function writeCurrentAndFallback(payload) {
  await fs.writeFile(TEMP_FILE, JSON.stringify(payload, null, 2));
  await fs.rename(TEMP_FILE, CURRENT_FILE);
  await fs.copyFile(CURRENT_FILE, LAST_SUCCESS_FILE);
}

async function main() {
  await ensureOutputDir();
  let releaseLock;
  try {
    releaseLock = await acquireLock();
  } catch (err) {
    warn(err.message);
    return;
  }

  try {
    await restoreFallbackIfNeeded();

    const age = await cacheAgeMs();
    if (age !== null && age < CACHE_INTERVAL_MS) {
      log('Cache valid – skipping update');
      return;
    }

    log('Cache expired – start fetch');
    const { payload, successCount, failureCount } = await buildField();
    const successRatio = successCount / totalPoints;

    if (successRatio < 0.8) {
      warn('Partial data – fallback not updated');
      return;
    }

    await writeCurrentAndFallback(payload);
    log('Update successful – fallback refreshed');
    log('Update complete');
  } catch (err) {
    if (err?.global429 || err?.http429) {
      warn('HTTP 429 – keeping last data');
      warn('Update failed – using last successful data');
      return;
    }
    warn(`Update failed – using last successful data (${err.message})`);
  } finally {
    if (releaseLock) {
      await releaseLock();
    }
  }
}

main().catch((err) => {
  console.error('[wind] Nicht behandelter Fehler:', err);
  process.exitCode = 1;
});

process.on('SIGINT', () => {
  console.log('\n[wind] Beende auf Benutzerwunsch.');
  process.exit(0);
});
