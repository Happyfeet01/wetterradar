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

const BOUNDS = Object.freeze({
  west: -25,
  east: 35,
  south: 33,
  north: 72
});

const GRID_STEP = (() => {
  const value = Number(process.env.WIND_GRID_STEP);
  return Number.isFinite(value) && value > 0 ? value : 1;
})();

const API_URL = process.env.WIND_API_URL ?? 'https://api.open-meteo.com/v1/dwd-icon';
const OUTPUT_DIR = process.env.WIND_OUTPUT_DIR ?? '/var/www/wetterradar/wind';
const OUTPUT_FILE = process.env.WIND_OUTPUT_FILE ?? path.join(OUTPUT_DIR, 'current.json');
const FALLBACK_FILE = process.env.WIND_FALLBACK_FILE ?? path.join(OUTPUT_DIR, 'fallback.json');

const HOURLY_PARAMS = 'wind_speed_10m,wind_direction_10m';
const MIN_TIMEOUT_MS = 90_000;

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
      return JSON.parse(body);
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

function normalizeAxis(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`Antwort enthält keine ${label}-Achse`);
  }
  const numeric = values.map((v) => Number(v));
  if (numeric.some((v) => !Number.isFinite(v))) {
    throw new Error(`Ungültige ${label}-Werte im Antwortgitter`);
  }
  return numeric;
}

function flattenGrid(values, nx, ny, label) {
  if (!Array.isArray(values)) {
    throw new Error(`Antwort enthält keine Daten für ${label}`);
  }

  if (Array.isArray(values[0])) {
    if (values.length !== ny) {
      throw new Error(`Unerwartete Anzahl Zeilen für ${label}: ${values.length} (erwartet ${ny})`);
    }
    const flat = [];
    for (let row = 0; row < values.length; row++) {
      const line = values[row];
      if (!Array.isArray(line) || line.length !== nx) {
        throw new Error(
          `Unerwartete Spaltenanzahl in Zeile ${row} für ${label}: ${line?.length ?? 0} (erwartet ${nx})`
        );
      }
      flat.push(...line.map((v) => Number(v)));
    }
    return flat;
  }

  const flat = values.map((v) => Number(v));
  if (flat.length !== nx * ny) {
    throw new Error(
      `Unerwartete Datenlänge für ${label}: ${flat.length} (erwartet ${nx * ny})`
    );
  }
  return flat;
}

function gridToMatrix(values, nx, ny, label) {
  const flat = flattenGrid(values, nx, ny, label);
  const matrix = [];
  for (let row = 0; row < ny; row++) {
    const start = row * nx;
    matrix.push(flat.slice(start, start + nx));
  }
  return matrix;
}

function pickLayer(series, timeCount, label) {
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error(`Antwort enthält keine Werte für ${label}`);
  }
  if (timeCount && Array.isArray(series[0]) && series.length === timeCount) {
    return series[0];
  }
  return series;
}

function computeStep(axis) {
  if (axis.length < 2) return GRID_STEP;
  const diffs = [];
  for (let i = 1; i < axis.length; i++) {
    const diff = Math.abs(axis[i] - axis[i - 1]);
    if (diff > 0) {
      diffs.push(diff);
    }
  }
  if (!diffs.length) return GRID_STEP;
  const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  return GRID_STEP > 0 ? GRID_STEP : avg;
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

async function ensureOutputDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function writeJsonAtomic(filePath, payload) {
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2));
  await fs.promises.rename(tmpPath, filePath);
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

function buildPayload(apiData) {
  const latitudes = normalizeAxis(apiData.latitude, 'Breiten');
  const longitudes = normalizeAxis(apiData.longitude, 'Längen');
  const nx = longitudes.length;
  const ny = latitudes.length;
  const total = nx * ny;

  const hourly = apiData.hourly ?? {};
  const times = hourly.time;
  if (!Array.isArray(times) || times.length === 0) {
    throw new Error('Antwort enthält keine Stundenzeiten');
  }
  const datasetTimeIso = toIsoString(times[0]);
  if (!datasetTimeIso) {
    throw new Error('Antwortzeitpunkt konnte nicht geparst werden');
  }

  const speedLayer = pickLayer(hourly.wind_speed_10m, times.length, 'wind_speed_10m');
  const dirLayer = pickLayer(hourly.wind_direction_10m, times.length, 'wind_direction_10m');

  const speedMatrix = gridToMatrix(speedLayer, nx, ny, 'wind_speed_10m');
  const dirMatrix = gridToMatrix(dirLayer, nx, ny, 'wind_direction_10m');

  const latAscending = latitudes[0] < latitudes[latitudes.length - 1];
  const lonAscending = longitudes[0] < longitudes[longitudes.length - 1];

  const dx = computeStep(longitudes);
  const dy = computeStep(latitudes);
  const lo1 = BOUNDS.west;
  const la1 = BOUNDS.north;
  const lo2 = lo1 + (nx - 1) * dx;
  const la2 = la1 - (ny - 1) * dy;

  const uData = new Array(total).fill(null);
  const vData = new Array(total).fill(null);
  const points = [];

  for (let j = 0; j < ny; j++) {
    const lat = la1 - j * dy;
    const srcRow = latAscending ? ny - 1 - j : j;
    for (let i = 0; i < nx; i++) {
      const lon = lo1 + i * dx;
      const srcCol = lonAscending ? i : nx - 1 - i;
      const idx = j * nx + i;
      points.push({ idx, lat, lon, srcRow, srcCol });
    }
  }

  for (const point of points) {
    const speed = speedMatrix[point.srcRow]?.[point.srcCol];
    const direction = dirMatrix[point.srcRow]?.[point.srcCol];
    const { u, v } = toVector(speed, direction);
    uData[point.idx] = u;
    vData[point.idx] = v;
  }

  if (uData.length !== total || vData.length !== total) {
    throw new Error('Gitterlänge stimmt nicht mit erwarteter Punktzahl überein');
  }
  validateFinite(uData, 'u-Komponenten', total);
  validateFinite(vData, 'v-Komponenten', total);

  const generated = new Date().toISOString();
  const cornerDebug = [
    { idx: 0, lon: lo1, lat: la1 },
    { idx: nx - 1, lon: lo2, lat: la1 },
    { idx: (ny - 1) * nx, lon: lo1, lat: la2 },
    { idx: total - 1, lon: lo2, lat: la2 }
  ];
  console.debug(
    '[wind] Grid sanity check',
    JSON.stringify({
      expectedLength: total,
      uLength: uData.length,
      vLength: vData.length,
      corners: cornerDebug
    })
  );

  const headerBase = {
    parameterCategory: 2,
    parameterUnit: 'm.s-1',
    refTime: datasetTimeIso,
    lo1,
    la1,
    lo2,
    la2,
    nx,
    ny,
    dx,
    dy,
    scanMode: 0
  };

  return {
    meta: {
      bounds: [lo1, la2, lo2, la1],
      nx,
      ny,
      dx,
      dy,
      datasetTime: datasetTimeIso,
      updatedAt: generated,
      source: 'Open-Meteo DWD ICON (10 m Wind)'
    },
    generated,
    field: [
      { header: { ...headerBase, parameterNumber: 2 }, data: uData },
      { header: { ...headerBase, parameterNumber: 3 }, data: vData }
    ]
  };
}

async function fetchFromApi() {
  const url = new URL(API_URL);
  url.searchParams.set('latitude_min', BOUNDS.south);
  url.searchParams.set('latitude_max', BOUNDS.north);
  url.searchParams.set('longitude_min', BOUNDS.west);
  url.searchParams.set('longitude_max', BOUNDS.east);
  url.searchParams.set('latitude_step', GRID_STEP);
  url.searchParams.set('longitude_step', GRID_STEP);
  url.searchParams.set('hourly', HOURLY_PARAMS);
  url.searchParams.set('forecast_hours', '1');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('wind_speed_unit', 'ms');

  try {
    const data = await fetchJson(url.toString(), { cache: 'no-store' });
    return { data };
  } catch (err) {
    if (err?.status === 429) {
      console.warn('[wind] API rate limit (429) – behalte letzte erfolgreiche Datei.');
      return { rateLimited: true };
    }
    throw err;
  }
}

async function updateFiles(payload) {
  await ensureOutputDir(OUTPUT_DIR);
  await writeJsonAtomic(OUTPUT_FILE, payload);
  await fs.promises.chmod(OUTPUT_FILE, 0o664);
  await fs.promises.copyFile(OUTPUT_FILE, FALLBACK_FILE);
  await fs.promises.chmod(FALLBACK_FILE, 0o664);
}

async function main() {
  assertBounds();
  console.log(
    `[wind] Starte Open-Meteo ICON Bounding Box Fetch (${BOUNDS.west},${BOUNDS.south}) – (${BOUNDS.east},${BOUNDS.north})`
  );

  try {
    const result = await fetchFromApi();
    if (result.rateLimited) {
      return;
    }
    const payload = buildPayload(result.data);
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
