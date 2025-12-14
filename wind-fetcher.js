#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const fetchFn = globalThis.fetch
  ? (...args) => globalThis.fetch(...args)
  : async (...args) => {
      const { default: fetch } = await import('node-fetch');
      return fetch(...args);
    };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_OUTPUT_DIR = process.env.WIND_OUTPUT_DIR ?? '/var/www/wetterradar/wind';

const clampNumber = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const parseArgs = () => {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const token = process.argv[i];
    if (!token.startsWith('--')) continue;
    const key = token
      .replace(/^--/, '')
      .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
};

const argv = parseArgs();
const mode = String(argv.mode || process.env.WIND_MODE || 'regional').toLowerCase();
const isGlobal = mode === 'global';

const globalBounds = {
  west: clampNumber(argv.west ?? -180, -180),
  east: clampNumber(argv.east ?? 180, 180),
  north: clampNumber(argv.north ?? 85, 85),
  south: clampNumber(argv.south ?? -85, -85)
};

const defaultBounds = {
  north: clampNumber(process.env.WIND_LAT_MAX, 72.0),
  south: clampNumber(process.env.WIND_LAT_MIN, 33.0),
  west: clampNumber(process.env.WIND_LON_MIN, -12.0),
  east: clampNumber(process.env.WIND_LON_MAX, 33.0)
};

const bounds = isGlobal ? globalBounds : defaultBounds;

if (bounds.north <= bounds.south) {
  throw new Error('WIND_LAT_MAX must be larger than WIND_LAT_MIN');
}
if (bounds.east <= bounds.west) {
  throw new Error('WIND_LON_MAX must be larger than WIND_LON_MIN');
}

const latStep = clampNumber(
  argv.latStep ?? argv.latstep ?? process.env.WIND_LAT_STEP,
  isGlobal ? 2.0 : 2.0
) || 2.0;
const lonStep = clampNumber(
  argv.lonStep ?? argv.lonstep ?? process.env.WIND_LON_STEP,
  isGlobal ? 2.0 : 2.0
) || 2.0;
const refreshMinutes = clampNumber(
  argv.refreshMinutes ?? process.env.WIND_REFRESH_MINUTES,
  isGlobal ? 360 : 180
) || (isGlobal ? 360 : 180);
const requestDelayMs = Math.max(0, clampNumber(process.env.WIND_REQUEST_DELAY_MS, 150) || 0);

const apiBase = process.env.WIND_API_URL ?? 'https://api.open-meteo.com/v1/gfs';
const hourlyParams = process.env.WIND_API_PARAMS ?? 'wind_speed_10m,wind_direction_10m';
const apiTimezone = process.env.WIND_API_TZ ?? 'UTC';
const apiForecastDays = clampNumber(process.env.WIND_API_FORECAST_DAYS, 1) || 1;

const coordinatePrecision = clampNumber(process.env.WIND_COORD_PRECISION, 3) || 3;

const CACHE_MAX_AGE_MS =
  Math.max(1, clampNumber(argv.ttlHours ?? argv.ttlhours ?? process.env.WIND_CACHE_HOURS, 12)) *
  60 *
  60 *
  1000;

const OUTPUT_DIR = argv.outDir ?? argv.outputDir ?? DEFAULT_OUTPUT_DIR;
const OUTPUT_FILE = argv.out ?? path.join(OUTPUT_DIR, isGlobal ? 'global.json' : 'current.json');
const CURRENT_FILE =
  argv.alsoWriteCurrent ?? argv.alsoWritecurrent ?? path.join(OUTPUT_DIR, 'current.json');
const FALLBACK_FILE = path.join(OUTPUT_DIR, 'fallback.json');

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

async function ensureOutputDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function writeJson(filePath, payload) {
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2));
  await fs.promises.rename(tmpPath, filePath);
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
      updatedAt: new Date().toISOString(),
      refreshMinutes,
      source: 'Open-Meteo GFS (10 m Wind)',
      api: apiBase,
      bounds: { ...bounds },
      grid: {
        mode: isGlobal ? 'global' : 'custom',
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

async function readUpdatedAt(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const json = JSON.parse(raw);
    const updated = json?.meta?.updatedAt || json?.meta?.generated || json?.generated;
    const ts = updated ? new Date(updated) : null;
    if (ts && !Number.isNaN(ts.getTime())) {
      return ts;
    }
  } catch {
    // ignore
  }
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.mtime;
  } catch {
    return null;
  }
}

async function copyIfNeeded(source, target) {
  if (!target || source === target) return;
  await fs.promises.copyFile(source, target);
}

async function generateWindDataFromApi(outFile) {
  console.log(
    `[wind] Aktualisiere Feld (${latitudes.length}×${longitudes.length} Raster, ${totalPoints} Punkte)...`
  );
  const payload = await buildField();
  await ensureOutputDir(path.dirname(outFile));
  await writeJson(outFile, payload);
  await copyIfNeeded(outFile, CURRENT_FILE);
  await copyIfNeeded(outFile, FALLBACK_FILE);
  console.log(
    `[wind] ${outFile} aktualisiert – Zeitstempel ${payload.meta.datasetTime}, max ${payload.meta.stats.maxVelocity} m/s`
  );
}

async function useCacheIfValid(filePath, ttlMs) {
  const updatedAt = await readUpdatedAt(filePath);
  if (!updatedAt) return false;
  if (Date.now() - updatedAt.getTime() < ttlMs) {
    console.log('[wind] cache still valid');
    await copyIfNeeded(filePath, CURRENT_FILE);
    return true;
  }
  return false;
}

async function logSanityCheck(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const json = JSON.parse(raw);
    const meta = json.meta ?? {};
    const field = json.data ?? json.field ?? json.points ?? [];
    let pointCount = 0;

    if (Array.isArray(field)) {
      if (Array.isArray(field[0])) {
        pointCount = field.reduce((sum, row) => sum + (Array.isArray(row) ? row.length : 0), 0);
      } else if (field[0]?.data && Array.isArray(field[0].data)) {
        pointCount = field[0].data.length;
      } else {
        pointCount = field.length;
      }
    }

    const nx = Number(meta.nx ?? meta.cols ?? meta.grid?.nx ?? 0);
    const ny = Number(meta.ny ?? meta.rows ?? meta.grid?.ny ?? 0);
    const expected = nx * ny;

    if (expected > 0 && pointCount > 0 && expected === pointCount) {
      console.log(`[wind] Sanity-Check OK – nx * ny = ${expected}, Feldpunkte = ${pointCount}`);
    } else {
      console.warn(`[wind] WARNUNG: Sanity-Check FEHLER – nx * ny = ${expected}, Feldpunkte = ${pointCount}`);
    }
  } catch (err) {
    console.warn('[wind] Konnte Sanity-Check nicht durchführen:', err);
  }
}

async function main() {
  let useCache = false;

  try {
    useCache = await useCacheIfValid(OUTPUT_FILE, CACHE_MAX_AGE_MS);
  } catch (err) {
    console.warn('[wind] Konnte bestehenden Cache nicht prüfen, hole neue Daten:', err);
  }

  if (!useCache) {
    console.log('[wind] Cache expired or missing – start fetch');
    try {
      await generateWindDataFromApi(OUTPUT_FILE);
    } catch (err) {
      console.error('[wind] Fetch failed:', err);
      if (fs.existsSync(OUTPUT_FILE)) {
        console.log('[wind] Keeping last successful file');
        await copyIfNeeded(OUTPUT_FILE, CURRENT_FILE);
      } else if (fs.existsSync(FALLBACK_FILE)) {
        console.log('[wind] Using fallback (last successful run)');
        await copyIfNeeded(FALLBACK_FILE, OUTPUT_FILE);
        await copyIfNeeded(OUTPUT_FILE, CURRENT_FILE);
      } else {
        console.error('[wind] Kein Fallback verfügbar – es bleibt der alte Stand erhalten, falls vorhanden.');
      }
    }
  }

  await logSanityCheck(OUTPUT_FILE);
}

main().catch((err) => {
  console.error('[wind] Unbehandelter Fehler:', err);
  process.exitCode = 1;
});
