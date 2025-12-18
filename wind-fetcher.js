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

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      result.out = argv[++i];
    } else if (arg === '--ttl-hours' && argv[i + 1]) {
      result.ttlHours = Number(argv[++i]);
    } else if (arg === '--region' && argv[i + 1]) {
      result.region = argv[++i];
    }
  }
  return result;
}

const cliOptions = parseArgs(process.argv.slice(2));

const BOUNDS = Object.freeze({
  west: -25,
  east: 35,
  south: 33,
  north: 72
});

const GRID_STEP = 1;

const API_URL = process.env.WIND_API_URL ?? 'https://api.open-meteo.com/v1/dwd-icon';
const OUTPUT_FILE = cliOptions.out
  ? path.resolve(cliOptions.out)
  : process.env.WIND_OUTPUT_FILE ?? path.join('/var/www/wetterradar/wind', 'current.json');
const OUTPUT_DIR = path.dirname(OUTPUT_FILE);
const FALLBACK_FILE = process.env.WIND_FALLBACK_FILE ?? path.join(OUTPUT_DIR, 'fallback.json');
const TTL_HOURS = (() => {
  const value = cliOptions.ttlHours ?? Number(process.env.WIND_TTL_HOURS);
  return Number.isFinite(value) && value > 0 ? value : null;
})();

// Open-Meteo: "time" wird in hourly.time immer automatisch geliefert und darf NICHT in hourly= stehen.
const HOURLY_PARAMS = 'wind_speed_10m,wind_direction_10m';
const MIN_TIMEOUT_MS = 90_000;
const MAX_BATCH_SIZE = 50;

async function fetchJson(url, opts = {}) {
  const attempts = 3;
  const backoff = [500, 1500];

  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, backoff[i - 1]));
    }

    let res;
    let body = '';
    let contentType = '';
    const controller = new AbortController();
    const timeoutMs = Math.max(MIN_TIMEOUT_MS, Number(opts.timeoutMs) || 0);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      res = await fetchFn(url, { ...opts, signal: controller.signal });
      body = await res.text();
      contentType = res.headers.get('content-type') || '';
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        throw new Error(`Fetch timeout nach ${timeoutMs}ms`);
      }
      throw err;
    }
    clearTimeout(timer);

    if (!res.ok) {
      const preview = body.slice(0, 200).replace(/\s+/g, ' ');
      const error = new Error(
        `Open-Meteo Fehler ${res.status} ${res.statusText}: ${preview}`
      );
      error.status = res.status;
      throw error;
    }

    if (!contentType.includes('application/json')) {
      const preview = body.slice(0, 200).replace(/\s+/g, ' ');
      const error = new Error(
        `Unerwarteter Content-Type: ${contentType || 'unbekannt'} – Body-Ausschnitt: ${preview}`
      );
      error.status = res.status;
      throw error;
    }

    if (!body || body.length === 0) {
      const error = new Error('Leere API-Antwort erhalten');
      error.status = res.status;
      throw error;
    }

    try {
      const parsed = JSON.parse(body);
      return { json: parsed, status: res.status, contentType };
    } catch (err) {
      const isTruncated = err?.message?.includes('Unexpected end of JSON input');
      if (isTruncated && i < attempts - 1) {
        continue;
      }

      if (isTruncated) {
        const debugPayload = [
          `timestamp: ${new Date().toISOString()}`,
          `url: ${url}`,
          `status: ${res.status}`,
          `content-type: ${contentType || 'unbekannt'}`,
          `body-length: ${body.length}`,
          'body-preview:',
          body.slice(0, 1000)
        ].join('\n');

        try {
          await fs.promises.writeFile('/tmp/wind-openmeteo-debug.txt', debugPayload);
        } catch {
          // ignore debug write errors
        }
      }

      const parseError = new Error(`Konnte API-Antwort nicht parsen: ${err?.message ?? err}`);
      parseError.status = res.status;
      throw parseError;
    }
  }

  throw new Error('Unbekannter Fehler beim Abrufen der API');
}

function toIsoString(value) {
  if (!value) return null;
  try {
    return new Date(value.endsWith('Z') ? value : `${value}Z`).toISOString();
  } catch {
    return null;
  }
}

function assertBounds() {
  if (BOUNDS.west >= BOUNDS.east) {
    throw new Error('Invalid bounding box: west must be smaller than east');
  }
  if (BOUNDS.south >= BOUNDS.north) {
    throw new Error('Invalid bounding box: south must be smaller than north');
  }
}

function toVector(speed, directionDeg) {
  const speedMs = Number(speed);
  const dir = Number(directionDeg);
  if (!Number.isFinite(speedMs) || !Number.isFinite(dir)) {
    throw new Error('Ungültige Windkomponenten (NaN)');
  }
  const rad = (dir * Math.PI) / 180;
  const u = -speedMs * Math.sin(rad);
  const v = -speedMs * Math.cos(rad);
  return {
    u: Math.round(u * 1000) / 1000,
    v: Math.round(v * 1000) / 1000
  };
}

function isEmptyApiResponseError(err) {
  return err?.message?.includes('Leere API-Antwort erhalten') || err?.status === 204;
}

async function ensureOutputDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function writeJsonAtomic(filePath, payload) {
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2));
  await fs.promises.rename(tmpPath, filePath);
}

async function updateFiles(payload) {
  await ensureOutputDir(OUTPUT_DIR);
  await writeJsonAtomic(OUTPUT_FILE, payload);
  await fs.promises.chmod(OUTPUT_FILE, 0o664);
  await fs.promises.copyFile(OUTPUT_FILE, FALLBACK_FILE);
  await fs.promises.chmod(FALLBACK_FILE, 0o664);
}

function roundCoord(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function generateGridPoints() {
  const dx = GRID_STEP;
  const dy = GRID_STEP;
  const longitudes = [];
  for (let lon = BOUNDS.west; lon <= BOUNDS.east + 1e-9; lon += dx) {
    longitudes.push(roundCoord(lon));
  }

  const latitudes = [];
  for (let lat = BOUNDS.north; lat >= BOUNDS.south - 1e-9; lat -= dy) {
    latitudes.push(roundCoord(lat));
  }

  const points = [];
  for (let j = 0; j < latitudes.length; j++) {
    for (let i = 0; i < longitudes.length; i++) {
      points.push({ idx: points.length, lat: latitudes[j], lon: longitudes[i] });
    }
  }

  return {
    points,
    nx: longitudes.length,
    ny: latitudes.length,
    dx,
    dy,
    lo1: BOUNDS.west,
    la1: BOUNDS.north,
    lo2: roundCoord(BOUNDS.west + (longitudes.length - 1) * dx),
    la2: roundCoord(BOUNDS.north - (latitudes.length - 1) * dy)
  };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function extractLocationLayer(series, timeCount, locationCount, label) {
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error(`Antwort enthält keine Werte für ${label}`);
  }

  const first = series[0];
  if (Array.isArray(first)) {
    if (series.length === locationCount && first.length >= timeCount) {
      return series.map((row) => row[0]);
    }
    if (series.length === timeCount && first.length === locationCount) {
      return series[0];
    }
  }

  const flat = series.map((v) => Number(v));
  if (flat.length !== locationCount || flat.some((v) => !Number.isFinite(v))) {
    throw new Error(`Ungültige ${label}-Datenlänge: ${flat.length} (erwartet ${locationCount})`);
  }
  return flat;
}

function convertSpeedUnits(value, unit) {
  if (!Number.isFinite(value)) {
    throw new Error('Ungültiger Windgeschwindigkeitswert');
  }
  if (unit === 'km/h') {
    return value / 3.6;
  }
  return value;
}

async function writeInvalidResponseDebug({ url, status, contentType, json }) {
  const jsonPreview = (() => {
    try {
      return JSON.stringify(json).slice(0, 2000);
    } catch {
      return '[unserializable JSON]';
    }
  })();

  const debugPayload = { url, status, contentType, jsonPreview };
  try {
    await fs.promises.writeFile(
      '/tmp/wind-openmeteo-invalid.json',
      JSON.stringify(debugPayload, null, 2)
    );
  } catch {
    // ignore debug write errors
  }
}

function validateFinite(values, label, expectedLength) {
  if (values.length !== expectedLength) {
    throw new Error(
      `${label} Datenlänge stimmt nicht: ${values.length} (erwartet ${expectedLength})`
    );
  }
  if (values.some((v) => !Number.isFinite(v))) {
    throw new Error(`${label} enthält ungültige Werte`);
  }
}

function computeStats(uData, vData) {
  const uMin = Math.min(...uData);
  const uMax = Math.max(...uData);
  const vMin = Math.min(...vData);
  const vMax = Math.max(...vData);
  return { uMin, uMax, vMin, vMax };
}

async function fetchBatch(batchPoints) {
  const url = new URL(API_URL);
  url.searchParams.set('latitude', batchPoints.map((p) => p.lat).join(','));
  url.searchParams.set('longitude', batchPoints.map((p) => p.lon).join(','));
  url.searchParams.set('hourly', HOURLY_PARAMS);
  url.searchParams.set('forecast_hours', '1');
  url.searchParams.set('timezone', 'GMT');
  url.searchParams.set('wind_speed_unit', 'ms');

  const response = await fetchJson(url.toString(), { cache: 'no-store' });
  const { json: data, status, contentType } = response;
  const hourly = data.hourly ?? {};
  const times = hourly.time;
  const speeds = hourly.wind_speed_10m;
  const directions = hourly.wind_direction_10m;

  // Bei Multi-Location kann wind_speed_10m / wind_direction_10m 2D sein (Array< Array<number> >),
  // daher NICHT gegen times.length vergleichen. Wir prüfen nur die Mindeststruktur.
  const isInvalidResponse =
    !hourly ||
    !Array.isArray(times) || times.length === 0 ||
    !Array.isArray(speeds) || speeds.length === 0 ||
    !Array.isArray(directions) || directions.length === 0;

  if (isInvalidResponse) {
    await writeInvalidResponseDebug({
      url: url.toString(),
      status,
      contentType,
      json: data
    });
    const error = new Error('Antwort enthält keine Stundenzeiten');
    error.status = status;
    throw error;
  }

  const datasetTimeIso = toIsoString(times[0]);
  if (!datasetTimeIso) {
    throw new Error('Antwortzeitpunkt konnte nicht geparst werden');
  }

  const locationCount = batchPoints.length;

  let speedSeries, dirSeries;
  try {
    speedSeries = extractLocationLayer(hourly.wind_speed_10m, times.length, locationCount, 'wind_speed_10m');
    dirSeries = extractLocationLayer(hourly.wind_direction_10m, times.length, locationCount, 'wind_direction_10m');
  } catch (e) {
    // Falls Struktur doch anders ist: Debug schreiben, damit wir echte Payload sehen.
    await writeInvalidResponseDebug({ url: url.toString(), status, contentType, json: data });
    throw e;
  }

  const speedUnit = data.hourly_units?.wind_speed_10m;
  const vectors = batchPoints.map((point, idx) => {
    const speedValue = convertSpeedUnits(Number(speedSeries[idx]), speedUnit);
    const directionValue = Number(dirSeries[idx]);
    const { u, v } = toVector(speedValue, directionValue);
    return { idx: point.idx, u, v };
  });

  return { datasetTimeIso, vectors };
}

async function fetchWindField() {
  const grid = generateGridPoints();
  const total = grid.points.length;
  const uData = new Array(total).fill(null);
  const vData = new Array(total).fill(null);
  let datasetTime = null;

  const batches = chunkArray(grid.points, MAX_BATCH_SIZE);

  for (const batch of batches) {
    try {
      const { datasetTimeIso, vectors } = await fetchBatch(batch);
      datasetTime = datasetTime ?? datasetTimeIso;
      if (datasetTime && datasetTimeIso !== datasetTime) {
        console.warn('[wind] Warnung: Uneinheitliche Dataset-Zeitstempel zwischen Batches');
      }
      for (const vector of vectors) {
        uData[vector.idx] = vector.u;
        vData[vector.idx] = vector.v;
      }
    } catch (err) {
      if (err?.status === 429) {
        console.warn('[wind] API rate limit (429) – behalte letzte erfolgreiche Datei.');
        return { rateLimited: true };
      }
      if (isEmptyApiResponseError(err)) {
        console.warn('[wind] API lieferte eine leere Antwort – behalte letzte erfolgreiche Datei.');
        return { emptyResponse: true };
      }
      throw err;
    }
  }

  validateFinite(uData, 'u-Komponenten', total);
  validateFinite(vData, 'v-Komponenten', total);
  if (!datasetTime) {
    throw new Error('Dataset-Zeit konnte nicht bestimmt werden');
  }

  const headerBase = {
    parameterCategory: 2,
    parameterUnit: 'm.s-1',
    refTime: datasetTime,
    lo1: grid.lo1,
    la1: grid.la1,
    lo2: grid.lo2,
    la2: grid.la2,
    nx: grid.nx,
    ny: grid.ny,
    dx: grid.dx,
    dy: grid.dy,
    scanMode: 0
  };

  const generated = new Date().toISOString();
  const stats = computeStats(uData, vData);

  return {
    payload: {
      meta: {
        bounds: [grid.lo1, grid.la2, grid.lo2, grid.la1],
        nx: grid.nx,
        ny: grid.ny,
        dx: grid.dx,
        dy: grid.dy,
        datasetTime,
        updatedAt: generated,
        source: 'Open-Meteo DWD ICON (10 m Wind)'
      },
      field: [
        { header: { ...headerBase, parameterNumber: 2 }, data: uData },
        { header: { ...headerBase, parameterNumber: 3 }, data: vData }
      ],
      points: grid.points.map(({ lat, lon, idx }) => ({ lat, lon, idx })),
      stats,
      generated
    }
  };
}

function isCacheFresh(filePath, ttlHours) {
  if (!ttlHours) return false;
  try {
    const stat = fs.statSync(filePath);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs <= ttlHours * 3600 * 1000;
  } catch {
    return false;
  }
}

async function main() {
  assertBounds();
  if (cliOptions.region && cliOptions.region !== 'europe') {
    throw new Error(`Region ${cliOptions.region} wird nicht unterstützt`);
  }

  if (isCacheFresh(OUTPUT_FILE, TTL_HOURS)) {
    console.log(`[wind] Cache ist aktuell (<= ${TTL_HOURS}h) – überspringe Fetch.`);
    return;
  }

  console.log(
    `[wind] Starte Open-Meteo ICON Multi-Location Fetch (${BOUNDS.west},${BOUNDS.south}) – (${BOUNDS.east},${BOUNDS.north})`
  );

  try {
    const result = await fetchWindField();
    if (result.rateLimited || result.emptyResponse) {
      return;
    }
    const payload = result.payload;
    await updateFiles(payload);
    console.log(
      `[wind] ${OUTPUT_FILE} aktualisiert: ${payload.meta.nx}×${payload.meta.ny}, Dataset ${payload.meta.datasetTime}`
    );
  } catch (err) {
    console.error('[wind] Fetch failed:', err?.message ?? err);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[wind] Unbehandelter Fehler:', err);
  process.exitCode = 1;
});
