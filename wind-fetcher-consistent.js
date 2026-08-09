#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) result.out = argv[++i];
    else if (arg === '--ttl-hours' && argv[i + 1]) result.ttlHours = Number(argv[++i]);
    else if (arg === '--region' && argv[i + 1]) result.region = argv[++i];
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

const BOUNDS = Object.freeze({ west: -25, east: 35, south: 35, north: 72 });
const GRID_STEP = positiveNumber(process.env.WIND_STEP_DEG, 1.0);
const API_URL = process.env.WIND_API_URL ?? 'https://api.open-meteo.com/v1/dwd-icon';
const OUTPUT_FILE = args.out
  ? path.resolve(args.out)
  : process.env.WIND_OUTPUT_FILE ?? '/var/www/wetterradar/wind/current.json';
const OUTPUT_DIR = path.dirname(OUTPUT_FILE);
const FALLBACK_FILE = process.env.WIND_FALLBACK_FILE ?? path.join(OUTPUT_DIR, 'fallback.json');
const TTL_HOURS = Number.isFinite(args.ttlHours) && args.ttlHours > 0
  ? args.ttlHours
  : positiveNumber(process.env.WIND_TTL_HOURS, null);
const MAX_BATCH_SIZE = Math.max(1, Math.floor(positiveNumber(process.env.WIND_MAX_BATCH_SIZE, 10)));
const BATCH_DELAY_MS = nonNegativeNumber(process.env.WIND_BATCH_DELAY_MS, 3000);
const MAX_RETRIES = Math.max(0, Math.floor(nonNegativeNumber(process.env.WIND_MAX_RETRIES, 8)));
const BACKOFF_MS = nonNegativeNumber(process.env.WIND_BACKOFF_MS, 60000);
const WIND_VARIABLES = 'wind_speed_10m,wind_direction_10m';

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundCoord(value) {
  return Number(Number(value).toFixed(3));
}

function targetHourUtc(now = new Date()) {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 16);
}

function toIsoUtc(value) {
  if (!value) return null;
  const parsed = new Date(value.endsWith('Z') ? value : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function generateGrid() {
  const longitudes = [];
  for (let lon = BOUNDS.west; lon <= BOUNDS.east + 1e-9; lon += GRID_STEP) {
    longitudes.push(roundCoord(lon));
  }

  const latitudes = [];
  for (let lat = BOUNDS.north; lat >= BOUNDS.south - 1e-9; lat -= GRID_STEP) {
    latitudes.push(roundCoord(lat));
  }

  const points = [];
  for (const lat of latitudes) {
    for (const lon of longitudes) {
      points.push({ idx: points.length, lat, lon });
    }
  }

  return {
    points,
    nx: longitudes.length,
    ny: latitudes.length,
    dx: GRID_STEP,
    dy: GRID_STEP,
    lo1: BOUNDS.west,
    la1: BOUNDS.north,
    lo2: longitudes.at(-1),
    la2: latitudes.at(-1)
  };
}

function chunk(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function toVector(speedMs, directionDeg) {
  const rad = (directionDeg * Math.PI) / 180;
  return {
    u: Math.round((-speedMs * Math.sin(rad)) * 1000) / 1000,
    v: Math.round((-speedMs * Math.cos(rad)) * 1000) / 1000
  };
}

function isRetryable(err) {
  return err?.status === 429 || (err?.status >= 500 && err?.status <= 599);
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Open-Meteo ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (!text.trim()) throw new Error('Open-Meteo lieferte eine leere Antwort');
  return JSON.parse(text);
}

async function fetchBatch(batch, targetHour) {
  const url = new URL(API_URL);
  url.searchParams.set('latitude', batch.map((p) => p.lat).join(','));
  url.searchParams.set('longitude', batch.map((p) => p.lon).join(','));
  url.searchParams.set('hourly', WIND_VARIABLES);
  url.searchParams.set('start_hour', targetHour);
  url.searchParams.set('end_hour', targetHour);
  url.searchParams.set('timezone', 'GMT');
  url.searchParams.set('wind_speed_unit', 'ms');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const payload = await fetchJson(url.toString());
      const locations = Array.isArray(payload) ? payload : [payload];
      if (locations.length !== batch.length) {
        throw new Error(`Open-Meteo lieferte ${locations.length} Locations, erwartet ${batch.length}`);
      }

      const vectors = [];
      let datasetTime = null;

      for (let i = 0; i < locations.length; i++) {
        const loc = locations[i];
        const time = loc?.hourly?.time?.[0];
        const speed = Number(loc?.hourly?.wind_speed_10m?.[0]);
        const direction = Number(loc?.hourly?.wind_direction_10m?.[0]);
        const iso = toIsoUtc(time);

        if (!iso || !Number.isFinite(speed) || !Number.isFinite(direction)) {
          throw new Error(`Ungültige Winddaten für Batch-Punkt ${i}`);
        }
        datasetTime = datasetTime ?? iso;
        if (iso !== datasetTime) {
          throw new Error(`Uneinheitlicher Zeitstempel innerhalb eines Batches: ${datasetTime} / ${iso}`);
        }

        const vector = toVector(speed, direction);
        vectors.push({ idx: batch[i].idx, ...vector });
      }

      return { datasetTime, vectors };
    } catch (err) {
      if (!isRetryable(err) || attempt >= MAX_RETRIES) throw err;
      const waitMs = BACKOFF_MS * (attempt + 1);
      console.warn(`[wind] Open-Meteo ${err.status} erhalten, warte ${waitMs} ms vor Versuch ${attempt + 1}`);
      await sleep(waitMs);
    }
  }

  throw new Error('Unerreichbarer Zustand beim Wind-Abruf');
}

function validate(values, label) {
  if (values.some((v) => !Number.isFinite(v))) {
    throw new Error(`${label} enthält fehlende oder ungültige Werte`);
  }
}

function computeStats(uData, vData) {
  return {
    uMin: Math.min(...uData),
    uMax: Math.max(...uData),
    vMin: Math.min(...vData),
    vMax: Math.max(...vData)
  };
}

async function writeJsonAtomic(filePath, payload) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2));
  await fs.promises.rename(tmp, filePath);
  await fs.promises.chmod(filePath, 0o664);
}

async function updateFiles(payload) {
  await writeJsonAtomic(OUTPUT_FILE, payload);
  await fs.promises.copyFile(OUTPUT_FILE, FALLBACK_FILE);
  await fs.promises.chmod(FALLBACK_FILE, 0o664);
}

function isCacheFresh() {
  if (!TTL_HOURS) return false;
  try {
    const ageMs = Date.now() - fs.statSync(OUTPUT_FILE).mtimeMs;
    return ageMs <= TTL_HOURS * 3600 * 1000;
  } catch {
    return false;
  }
}

async function fetchWindField() {
  const grid = generateGrid();
  const batches = chunk(grid.points, MAX_BATCH_SIZE);
  const targetHour = targetHourUtc();
  const expectedDatasetTime = toIsoUtc(targetHour);
  const uData = new Array(grid.points.length).fill(null);
  const vData = new Array(grid.points.length).fill(null);

  console.log(`[wind] Fester Dataset-Zeitpunkt: ${expectedDatasetTime}`);
  console.log(`[wind] Rufe ${grid.points.length} Punkte in ${batches.length} Batches ab (Größe ${MAX_BATCH_SIZE}, Modus hourly-fixed).`);

  for (let i = 0; i < batches.length; i++) {
    const { datasetTime, vectors } = await fetchBatch(batches[i], targetHour);
    if (datasetTime !== expectedDatasetTime) {
      throw new Error(`Open-Meteo lieferte ${datasetTime}, erwartet ${expectedDatasetTime}`);
    }
    for (const vector of vectors) {
      uData[vector.idx] = vector.u;
      vData[vector.idx] = vector.v;
    }
    if (i < batches.length - 1) await sleep(BATCH_DELAY_MS);
  }

  validate(uData, 'u-Komponenten');
  validate(vData, 'v-Komponenten');

  const generated = new Date().toISOString();
  const header = {
    parameterCategory: 2,
    parameterUnit: 'm.s-1',
    refTime: expectedDatasetTime,
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

  return {
    meta: {
      bounds: [grid.lo1, grid.la2, grid.lo2, grid.la1],
      nx: grid.nx,
      ny: grid.ny,
      dx: grid.dx,
      dy: grid.dy,
      datasetTime: expectedDatasetTime,
      updatedAt: generated,
      source: 'Open-Meteo DWD ICON (10 m Wind)'
    },
    field: [
      { header: { ...header, parameterNumber: 2 }, data: uData },
      { header: { ...header, parameterNumber: 3 }, data: vData }
    ],
    points: grid.points,
    stats: computeStats(uData, vData),
    generated
  };
}

async function main() {
  if (args.region && args.region !== 'europe') {
    throw new Error(`Region ${args.region} wird nicht unterstützt`);
  }
  if (isCacheFresh()) {
    console.log(`[wind] Cache ist aktuell (<= ${TTL_HOURS}h) – überspringe Fetch.`);
    return;
  }

  console.log(`[wind] Starte Open-Meteo ICON Multi-Location Fetch (${BOUNDS.west},${BOUNDS.south}) – (${BOUNDS.east},${BOUNDS.north})`);
  const payload = await fetchWindField();
  await updateFiles(payload);
  console.log(`[wind] ${OUTPUT_FILE} aktualisiert: ${payload.meta.nx}×${payload.meta.ny}, Dataset ${payload.meta.datasetTime}`);
}

main().catch((err) => {
  console.error('[wind] Fetch failed:', err?.message ?? err);
  process.exitCode = 1;
});
