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
const OUTPUT_DIR = process.env.WIND_OUTPUT_DIR ?? path.join(__dirname, 'wind');
const CURRENT_FILE = path.join(OUTPUT_DIR, 'current.json');
const FALLBACK_FILE = path.join(OUTPUT_DIR, 'fallback.json');
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
const requestTimeoutMs = Math.max(1000, clampNumber(process.env.WIND_REQUEST_TIMEOUT_MS, 10000) || 10000);

const apiBase = process.env.WIND_API_URL ?? 'https://api.open-meteo.com/v1/gfs';
const hourlyParams = process.env.WIND_API_PARAMS ?? 'wind_speed_10m,wind_direction_10m';
const apiTimezone = process.env.WIND_API_TZ ?? 'UTC';
const apiForecastDays = clampNumber(process.env.WIND_API_FORECAST_DAYS, 1) || 1;
const forceFallback = process.env.WIND_FORCE_FALLBACK === '1';

const coordinatePrecision = clampNumber(process.env.WIND_COORD_PRECISION, 3) || 3;

const toNumber = (value, fallback = null) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

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

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function seedFallbackFromCurrent() {
  const hasFallback = await readJsonSafe(FALLBACK_FILE);
  if (hasFallback) return;

  const current = await readJsonSafe(CURRENT_FILE);
  if (!current) return;

  const normalized = normalizePayload(current);
  if (!normalized) return;

  await fs.writeFile(FALLBACK_FILE, JSON.stringify(normalized, null, 2));
  log('Fallback initialisiert aus vorhandenem current.json');
}

async function normalizeExistingFiles() {
  const files = [CURRENT_FILE, FALLBACK_FILE];
  for (const file of files) {
    const json = await readJsonSafe(file);
    if (!json) continue;
    const normalized = normalizePayload(json);
    if (!normalized) continue;
    await fs.writeFile(file, JSON.stringify(normalized, null, 2));
  }
}

function normalizeBounds(boundsValue) {
  if (Array.isArray(boundsValue) && boundsValue.length >= 4) {
    const [w, s, e, n] = boundsValue;
    return [toNumber(w, bounds.west), toNumber(s, bounds.south), toNumber(e, bounds.east), toNumber(n, bounds.north)];
  }
  if (boundsValue && typeof boundsValue === 'object') {
    return [
      toNumber(boundsValue.west, bounds.west),
      toNumber(boundsValue.south, bounds.south),
      toNumber(boundsValue.east, bounds.east),
      toNumber(boundsValue.north, bounds.north)
    ];
  }
  return [bounds.west, bounds.south, bounds.east, bounds.north];
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const field = Array.isArray(payload.field)
    ? payload.field
    : Array.isArray(payload.data)
      ? payload.data
      : [];

  const updatedAt = getUpdatedAt(payload) ?? new Date().toISOString();
  const headerSample = field?.[0]?.header ?? payload?.points?.[0]?.header ?? {};

  const normalizedField = field.map((entry) => ({
    header: {
      ...entry.header,
      nx: toNumber(entry.header?.nx ?? headerSample.nx, longitudes.length),
      ny: toNumber(entry.header?.ny ?? headerSample.ny, latitudes.length),
      lo1: toNumber(entry.header?.lo1 ?? headerSample.lo1 ?? bounds.west, bounds.west),
      lo2: toNumber(entry.header?.lo2 ?? headerSample.lo2 ?? bounds.east, bounds.east),
      la1: toNumber(entry.header?.la1 ?? headerSample.la1 ?? bounds.north, bounds.north),
      la2: toNumber(entry.header?.la2 ?? headerSample.la2 ?? bounds.south, bounds.south),
      dx: toNumber(entry.header?.dx ?? headerSample.dx ?? lonStep, lonStep),
      dy: toNumber(entry.header?.dy ?? headerSample.dy ?? latStep, latStep)
    },
    data: (entry.data || []).map((v) => (typeof v === 'number' ? v : toNumber(v, null)))
  }));

  return {
    meta: {
      bounds: normalizeBounds(payload.meta?.bounds ?? payload.bounds),
      nx: toNumber(payload.meta?.nx ?? payload.meta?.grid?.nx ?? headerSample.nx, longitudes.length),
      ny: toNumber(payload.meta?.ny ?? payload.meta?.grid?.ny ?? headerSample.ny, latitudes.length),
      dx: toNumber(payload.meta?.dx ?? payload.meta?.grid?.longitudeStep ?? headerSample.dx, lonStep),
      dy: toNumber(payload.meta?.dy ?? payload.meta?.grid?.latitudeStep ?? headerSample.dy, latStep),
      datasetTime: payload.meta?.datasetTime ?? payload.datasetTime ?? null,
      updatedAt,
      source: payload.meta?.source ?? payload.source ?? 'Open-Meteo (GFS 10m)'
    },
    field: normalizedField,
    points: payload.points ?? [],
    stats: payload.stats ?? null,
    generated: updatedAt
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

  let res;
  try {
    res = await fetchFn(url, { cache: 'no-store', signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      const error = new Error('Open-Meteo Timeout');
      error.httpFatal = true;
      throw error;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) {
    const error = new Error('Open-Meteo HTTP 429');
    error.http429 = true;
    throw error;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const error = new Error(`Open-Meteo ${res.status} ${res.statusText}: ${text.slice(0, 160)}`);
    error.httpFatal = true;
    throw error;
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
  return { u, v, datasetTime: times[index], datasetDir: direction };
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
  const points = [];
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
        points[idx] = {
          lat,
          lon,
          u: point.u,
          v: point.v,
          speed: Math.round(Math.hypot(point.u, point.v) * 1000) / 1000,
          dir: Number.isFinite(point.datasetDir) ? point.datasetDir : null
        };
        successCount += 1;
      } catch (err) {
        if (err?.http429) {
          err.global429 = true;
          throw err;
        }
        if (err?.httpFatal) {
          err.globalFatal = true;
          throw err;
        }
        uData[idx] = null;
        vData[idx] = null;
        points[idx] = { lat, lon, u: null, v: null, speed: null, dir: null };
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

  const updatedAt = new Date().toISOString();
  const meta = {
    bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
    nx: longitudes.length,
    ny: latitudes.length,
    dx: lonStep,
    dy: latStep,
    datasetTime: datasetTimeIso,
    updatedAt,
    source: 'Open-Meteo (GFS 10m)'
  };

  const payload = {
    meta,
    field: [
      { header: headers[0], data: uData },
      { header: headers[1], data: vData }
    ],
    points,
    stats,
    generated: updatedAt
  };

  return { payload, successCount, failureCount };
}

function getUpdatedAt(json) {
  const updated = json?.meta?.updatedAt ?? json?.generated ?? json?.meta?.generated;
  const parsed = updated ? Date.parse(updated) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function cacheAgeMs(json) {
  const updatedAt = getUpdatedAt(json);
  if (!updatedAt) return null;
  return Date.now() - Date.parse(updatedAt);
}

async function writeCurrentAndFallback(payload) {
  const normalized = normalizePayload(payload);
  if (!normalized) throw new Error('Payload konnte nicht normalisiert werden');

  await fs.writeFile(TEMP_FILE, JSON.stringify(normalized, null, 2));
  await fs.rename(TEMP_FILE, CURRENT_FILE);
  await fs.writeFile(FALLBACK_FILE, JSON.stringify(normalized, null, 2));
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
    await normalizeExistingFiles();
    await seedFallbackFromCurrent();
    const currentJson = await readJsonSafe(CURRENT_FILE);
    const currentAge = currentJson ? await cacheAgeMs(currentJson) : null;
    const lastRun = getUpdatedAt(currentJson);

    if (currentAge !== null && currentAge < CACHE_INTERVAL_MS) {
      log(`Cache still valid – using existing data (last successful run: ${lastRun ?? 'unbekannt'})`);
      return;
    }

    if (forceFallback) {
      log(`Force fallback aktiviert – verwende letzten erfolgreichen Lauf ${lastRun ?? 'unbekannt'}`);
      if (currentJson) {
        await fs.writeFile(FALLBACK_FILE, JSON.stringify(currentJson, null, 2));
      }
      return;
    }

    log('Cache expired – start fetch');
    const { payload, successCount, failureCount } = await buildField();
    const successRatio = successCount / totalPoints;
    log(`Punkte erfolgreich: ${successCount}/${totalPoints}, fehlgeschlagen: ${failureCount}`);

    if (successRatio < 0.8) {
      throw new Error(`Zu viele fehlende Punkte (${Math.round(successRatio * 100)}% gültig)`);
    }

    await writeCurrentAndFallback(payload);
    log(`Update successful – fallback refreshed (last successful run: ${payload.meta.updatedAt})`);
    log('Update complete');
  } catch (err) {
    const fallback = await readJsonSafe(FALLBACK_FILE);
    const lastRun = getUpdatedAt(fallback);

    if (err?.global429 || err?.http429) {
      warn(`Fetch failed (HTTP 429) – using last successful run from ${lastRun ?? 'unbekannt'}`);
    } else {
      warn(`Fetch failed (${err.message}) – using last successful run from ${lastRun ?? 'unbekannt'}`);
    }

    if (fallback) {
      const normalizedFallback = normalizePayload(fallback);
      if (normalizedFallback) {
        await fs.writeFile(TEMP_FILE, JSON.stringify(normalizedFallback, null, 2));
        await fs.rename(TEMP_FILE, CURRENT_FILE);
        await fs.writeFile(FALLBACK_FILE, JSON.stringify(normalizedFallback, null, 2));
        log('Update complete (fallback restored)');
      } else {
        warn('Fallback konnte nicht normalisiert werden – nichts geändert');
      }
    } else {
      warn('Kein Fallback vorhanden – nichts geändert');
    }
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
