import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

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

function formatDateUtc(date) {
  return `${date.getUTCFullYear()}${formatDatePart(date.getUTCMonth() + 1)}${formatDatePart(date.getUTCDate())}`;
}

export function buildCandidates(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const candidates = [];

  // Für heute nur Zyklen probieren, deren nominelle UTC-Laufzeit bereits
  // erreicht ist. Vorher wurde z. B. um 15 UTC bereits der 18z-Lauf
  // angefragt, was bei NOMADS zwangsläufig mit 403/404 endet.
  const currentUtcHour = now.getUTCHours();
  for (const cycle of CYCLES) {
    if (Number(cycle) <= currentUtcHour) {
      candidates.push({ date: formatDateUtc(today), cycle });
    }
  }

  // Vom Vortag dürfen alle vier Läufe als Fallback versucht werden.
  for (const cycle of CYCLES) {
    candidates.push({ date: formatDateUtc(yesterday), cycle });
  }

  return candidates;
}

export function buildNomadsUrl(date, cycle) {
  const url = new URL(NOMADS_BASE);
  url.searchParams.set('dir', `/gfs.${date}/${cycle}/atmos`);

  // Offizieller Dateiname des 1.00°-GFS lautet "1p00". Hier stand zuvor
  // versehentlich "1p0"; dadurch wurde eine nicht existierende Datei
  // angefordert und der NOMADS-Filter antwortete mit 500.
  url.searchParams.set('file', `gfs.t${cycle}z.pgrb2.1p00.f000`);
  url.searchParams.set('lev_10_m_above_ground', 'on');
  url.searchParams.set('var_UGRD', 'on');
  url.searchParams.set('var_VGRD', 'on');
  url.searchParams.set('leftlon', '0');
  url.searchParams.set('rightlon', '359');
  url.searchParams.set('toplat', '90');
  url.searchParams.set('bottomlat', '-90');
  return url.toString();
}

export function validateGribBuffer(input, contentType = '') {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  const prefixText = buffer.slice(0, 20).toString('utf8').trim().toLowerCase();

  if (String(contentType).toLowerCase().includes('text/html') || prefixText.startsWith('<!doctype') || prefixText.startsWith('<html')) {
    throw new Error('Received HTML error page');
  }

  // Die vorherige 200-KiB-Grenze war falsch: Ein von NOMADS auf nur UGRD/VGRD
  // und 10 m gefiltertes 1°-GRIB kann deutlich kleiner sein (z. B. ~159 KiB).
  // Deshalb prüfen wir die tatsächliche GRIB-Signatur statt einer geratenen Größe.
  if (buffer.length < 16) {
    throw new Error(`GRIB payload too small (${buffer.length} bytes)`);
  }

  const magic = buffer.subarray(0, 4).toString('ascii');
  if (magic !== 'GRIB') {
    throw new Error(`Unexpected payload signature ${JSON.stringify(magic)}`);
  }

  return buffer;
}

async function fetchBuffer(url) {
  log(`Fetching GRIB2 from ${url}`);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'wetterradar/1.0 (+https://github.com/Happyfeet01/wetterradar)'
    }
  });

  if (!response.ok) {
    throw new Error(`Unexpected status ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const arrayBuffer = await response.arrayBuffer();
  const buffer = validateGribBuffer(Buffer.from(arrayBuffer), contentType);
  log(`Accepted GRIB2 payload (${buffer.length} bytes)`);
  return buffer;
}

async function downloadLatestGrib(now = new Date()) {
  const candidates = buildCandidates(now);
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
  } finally {
    await fs.rm(outputPath, { force: true }).catch(() => {});
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

export async function main() {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
