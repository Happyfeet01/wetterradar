import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

const NOMADS_BASE = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl';
const CYCLES = ['18', '12', '06', '00'];
const DATA_DIR = '/var/lib/wetterradar/noaa-wind';
const WIND_DIR = '/var/www/wetterradar/wind';
const GRIB_PATH = path.join(DATA_DIR, 'gfs.grib2');
const GRIB2JSON_BIN = path.join(process.cwd(), 'node_modules', '.bin', 'grib2json');

function log(message) {
  console.log(`[noaa-wind] ${message}`);
}

function logError(message, error) {
  console.error(`[noaa-wind] ${message}${error ? `: ${error.message || error}` : ''}`);
}

function formatDatePart(value) {
  return value.toString().padStart(2, '0');
}

function buildCandidates() {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

  const dates = [today, yesterday];
  const candidates = [];

  for (const date of dates) {
    const y = date.getUTCFullYear();
    const m = formatDatePart(date.getUTCMonth() + 1);
    const d = formatDatePart(date.getUTCDate());
    for (const cycle of CYCLES) {
      candidates.push({
        date: `${y}${m}${d}`,
        cycle,
      });
    }
  }

  return candidates;
}

function buildNomadsUrl(date, cycle) {
  const url = new URL(NOMADS_BASE);
  url.searchParams.set('dir', `/gfs.${date}/${cycle}/atmos`);
  url.searchParams.set('file', `gfs.t${cycle}z.pgrb2.1p0.f000`);
  url.searchParams.set('lev_10_m_above_ground', 'on');
  url.searchParams.set('var_UGRD', 'on');
  url.searchParams.set('var_VGRD', 'on');
  url.searchParams.set('leftlon', '0');
  url.searchParams.set('rightlon', '359');
  url.searchParams.set('toplat', '90');
  url.searchParams.set('bottomlat', '-90');
  return url.toString();
}

async function fetchBuffer(url) {
  log(`Fetching GRIB2 from ${url}`);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Unexpected status ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const prefix = buffer.slice(0, 20).toString('utf8').trim().toLowerCase();

  if (contentType.includes('text/html') || prefix.startsWith('<!doctype') || prefix.startsWith('<html')) {
    throw new Error('Received HTML error page');
  }

  if (buffer.length <= 200 * 1024) {
    throw new Error(`File too small (${buffer.length} bytes)`);
  }

  return buffer;
}

async function downloadLatestGrib() {
  const candidates = buildCandidates();
  let lastError;

  for (const { date, cycle } of candidates) {
    const url = buildNomadsUrl(date, cycle);
    try {
      const buffer = await fetchBuffer(url);
      log(`Using dataset gfs.${date}/${cycle}`);
      return { buffer, date, cycle };
    } catch (error) {
      lastError = error;
      logError(`Failed for gfs.${date}/${cycle}`, error);
    }
  }

  throw new Error(`No available dataset found. Last error: ${lastError?.message || 'unknown'}`);
}

async function saveAtomic(filePath, buffer) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, buffer);
  await fs.rename(tmpPath, filePath);
}

async function convertGribToJson(gribPath) {
  const outputPath = path.join(tmpdir(), `grib-${Date.now()}.json`);
  try {
    await execFileAsync(GRIB2JSON_BIN, ['--compact', '--data', '--output', outputPath, gribPath]);
  } catch (error) {
    throw new Error(`grib2json failed (${error.code || 'unknown'}): ${error.message}`);
  }

  const content = await fs.readFile(outputPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON from grib2json: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error('Unexpected grib2json output structure');
  }

  return parsed;
}

function selectComponent(records, component) {
  const match = records.find((record) => {
    const name = record?.header?.parameterNumberName?.toLowerCase?.() || '';
    if (component === 'u') {
      return name.includes('u-component') || name.includes('u-component_of_wind');
    }
    return name.includes('v-component') || name.includes('v-component_of_wind');
  });

  return match || records[component === 'u' ? 0 : 1];
}

function analyze(records) {
  const uRecord = selectComponent(records, 'u');
  const vRecord = selectComponent(records, 'v');

  if (!uRecord?.data || !vRecord?.data) {
    throw new Error('Missing wind component data');
  }

  const { header } = uRecord;
  const { nx, ny } = header;

  if (!nx || !ny) {
    throw new Error('Missing grid dimensions');
  }

  const expected = nx * ny;
  if (uRecord.data.length !== expected || vRecord.data.length !== expected) {
    throw new Error('Grid size mismatch');
  }

  let valid = 0;
  let sumSpeed = 0;
  let maxVelocity = 0;
  for (let i = 0; i < expected; i += 1) {
    const u = uRecord.data[i];
    const v = vRecord.data[i];
    if (Number.isFinite(u) && Number.isFinite(v)) {
      valid += 1;
      const speed = Math.hypot(u, v);
      sumSpeed += speed;
      if (speed > maxVelocity) {
        maxVelocity = speed;
      }
    }
  }

  const validRatio = valid / expected;
  if (validRatio < 0.95) {
    throw new Error(`Insufficient valid data (${(validRatio * 100).toFixed(2)}%)`);
  }

  const avgVelocity = valid ? sumSpeed / valid : 0;

  return {
    header,
    stats: { maxVelocity, avgVelocity },
    grid: { nx, ny },
  };
}

function buildPayload(records, analysis, nowIso) {
  const { header, stats, grid } = analysis;
  const bounds = {
    north: header.la1,
    south: header.la2,
    west: header.lo1,
    east: header.lo2,
  };

  const gridMeta = {
    nx: grid.nx,
    ny: grid.ny,
    dx: header.dx,
    dy: header.dy,
    points: grid.nx * grid.ny,
  };

  return {
    meta: {
      generated: nowIso,
      updatedAt: nowIso,
      datasetTime: header.refTime || null,
      source: 'NOAA/NCEP GFS 1.0° via NOMADS (10m wind)',
      api: NOMADS_BASE,
      bounds,
      grid: gridMeta,
      stats,
      refreshMinutes: 360,
    },
    data: records,
  };
}

async function main() {
  try {
    const { buffer, date, cycle } = await downloadLatestGrib();
    await saveAtomic(GRIB_PATH, buffer);
    log(`Saved GRIB2 to ${GRIB_PATH}`);

    const records = await convertGribToJson(GRIB_PATH);
    const analysis = analyze(records);
    const nowIso = new Date().toISOString();
    const payload = buildPayload(records, analysis, nowIso);

    const currentPath = path.join(WIND_DIR, 'current.json');
    await saveAtomic(currentPath, Buffer.from(JSON.stringify(payload, null, 2)));
    log(`Updated ${currentPath} from gfs.${date}/${cycle}`);

    const fallbackPath = path.join(WIND_DIR, 'fallback.json');
    await saveAtomic(fallbackPath, Buffer.from(JSON.stringify(payload, null, 2)));
    log(`Updated ${fallbackPath}`);
  } catch (error) {
    logError('Wind update failed', error);
    process.exitCode = 1;
  }
}

main();
