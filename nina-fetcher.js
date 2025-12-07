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
const REGION_FILE = path.resolve(__dirname, 'Regionalschluessel_2021-07-31.json');
const OUTPUT_DIR = path.resolve(__dirname, 'warnings');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'nina.geojson');

const API_BASE = 'https://nina.api.proxy.bund.dev/api31';
const USER_AGENT = 'wetterradar/1.0 (+https://wetter.larsmueller.net/)';
const SELECTED_STATE_CODES = (process.env.NINA_STATE_CODES || '06,09')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const severityMap = {
  extreme: 4,
  severe: 3,
  moderate: 2,
  minor: 1
};

function log(msg) {
  console.log(`[nina] ${msg}`);
}

async function readRegionFile() {
  try {
    const raw = await fs.readFile(REGION_FILE, 'utf8');
    const json = JSON.parse(raw);
    const entries = Array.isArray(json)
      ? json
      : Array.isArray(json?.features)
        ? json.features.map((f) => ({ ...f.properties, geometry: f.geometry }))
        : Array.isArray(json?.data)
          ? json.data
          : [];

    if (!entries.length) {
      throw new Error('Regionalschlüssel-Datei enthält keine Einträge');
    }

    const regions = entries
      .map(extractRegion)
      .filter((r) => r && typeof r.rs === 'string' && r.rs.length >= 5);

    log(`Regionalschlüssel geladen: ${entries.length} Einträge, ${regions.length} verwertbar`);
    return regions;
  } catch (err) {
    log(`Fehler beim Laden der Regionalschlüssel: ${err.message}`);
    process.exit(1);
  }
}

function extractRegion(entry) {
  const props = entry?.properties ?? entry ?? {};
  const geometry = entry?.geometry ?? props.geometry ?? null;
  const rs = pickNormalizedRs(props, (key) => /^(rs|ars|ags)$/i.test(key))
    || pickNormalizedRs(props, (key) => key.toLowerCase().includes('rs'));
  const name = pickValue(props, (key, value) => /^(gen|name|bezeichnung)$/i.test(key) && typeof value === 'string')
    || pickValue(props, (key, value) => key.toLowerCase().includes('name') && typeof value === 'string')
    || 'Unbekannte Region';
  const centroid = extractCentroid(props) || extractCentroid(entry);

  return rs
    ? {
        rs,
        name,
        geometry: normalizeGeometry(geometry),
        centroid
      }
    : null;
}

function extractCentroid(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const lat = pickNumeric([
    obj?.lat,
    obj?.latitude,
    obj?.y,
    obj?.centroid?.lat,
    obj?.centroid?.latitude,
    obj?.center?.lat
  ]);
  const lon = pickNumeric([
    obj?.lon,
    obj?.lng,
    obj?.longitude,
    obj?.x,
    obj?.centroid?.lon,
    obj?.centroid?.lng,
    obj?.centroid?.longitude,
    obj?.center?.lng,
    obj?.center?.lon
  ]);

  if (lat !== null && lon !== null) return { lat, lon };
  return null;
}

function normalizeGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  if (geometry.type && geometry.coordinates) return geometry;
  return null;
}

function pickValue(obj, predicate) {
  return Object.entries(obj || {}).find(([key, value]) => predicate(key, value))?.[1] ?? null;
}

function isValidRs(value) {
  const str = String(value ?? '').replace(/\D+/g, '');
  return str.length >= 8 ? str.padEnd(12, '0') : null;
}

function pickNormalizedRs(obj, predicate) {
  for (const [key, value] of Object.entries(obj || {})) {
    if (!predicate(key, value)) continue;
    const normalized = isValidRs(value);
    if (normalized) return normalized;
  }
  return null;
}

function pickNumeric(candidates) {
  for (const value of candidates) {
    const num = parseCoordinate(value);
    if (num !== null) return num;
  }
  return null;
}

function parseCoordinate(value) {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function fetchDashboard(rs) {
  const url = `${API_BASE}/dashboard/${rs}.json`;
  try {
    const res = await fetchFn(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT
      },
      cache: 'no-store'
    });

    if (res.status === 404) {
      log(`Dashboard ${rs}: 404 – keine Warnungen`);
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 160)}`);
    }

    const json = await res.json();
    return json;
  } catch (err) {
    log(`Fehler beim Dashboard-Request ${rs}: ${err.message}`);
    return null;
  }
}

async function fetchWarningDetails(identifier) {
  const url = `${API_BASE}/warnings/${identifier}.json`;
  try {
    const res = await fetchFn(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT
      },
      cache: 'no-store'
    });

    if (res.status === 404) {
      log(`Details ${identifier}: 404 – verwende Dashboard-Daten`);
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 160)}`);
    }

    return await res.json();
  } catch (err) {
    log(`Fehler beim Laden der Details ${identifier}: ${err.message}`);
    return null;
  }
}

function buildWarningEntry(identifier, region, dashboardWarning, detail) {
  const payload = dashboardWarning?.payload?.data ?? dashboardWarning?.payload ?? dashboardWarning?.data ?? {};
  const info = Array.isArray(detail?.info) ? detail.info[0] : (detail?.info?.[0] ?? detail?.info ?? {});
  const headline = payload?.headline || info?.headline || info?.event || info?.title || dashboardWarning?.headline;
  const description = payload?.description || info?.description || info?.instruction || info?.web || '';
  const provider = dashboardWarning?.provider || payload?.provider || info?.senderName || 'NINA';
  const category = payload?.category || info?.category || null;
  const event = payload?.event || info?.event || headline || 'Warnung';
  const status = detail?.status || payload?.status || dashboardWarning?.status || '';
  const severityRaw = String(info?.severity || payload?.severity || dashboardWarning?.severity || '').toLowerCase();
  const severityNumeric = Number.isFinite(Number(payload?.level))
    ? Number(payload.level)
    : Number.isFinite(Number(info?.level))
      ? Number(info.level)
      : null;
  const severity = (severityMap[severityRaw] ?? severityMap[severityRaw.replace(/\s+/g, '')] ?? severityNumeric) ?? 0;
  const onset = toIso(info?.onset || payload?.onset || dashboardWarning?.onset);
  const effective = toIso(info?.effective || payload?.effective || dashboardWarning?.effective);
  const expires = toIso(info?.expires || payload?.expires || dashboardWarning?.expires);

  if (isFalseAlarm(headline, description, status)) {
    return null;
  }

  return {
    id: identifier,
    rs: region?.rs,
    regionName: region?.name,
    provider,
    source: 'NINA',
    category,
    event,
    headline,
    description,
    severity,
    onset,
    effective,
    expires,
    geometry: region?.geometry || normalizeGeometry(info?.area?.geometry || info?.area),
    centroid: region?.centroid || geometryCenter(info?.area?.geometry || info?.area) || null
  };
}

function toIso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function isFalseAlarm(headline, description, status) {
  const text = `${headline || ''} ${description || ''}`.toLowerCase();
  if (String(status).toLowerCase() === 'allclear') return true;
  return text.includes('probealarm') || text.includes('testalarm') || text.includes('testwarnung') || text.includes('entwarnung');
}

function geometryCenter(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
    const [lon, lat] = geometry.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }

  const coords =
    geometry.type === 'Polygon'
      ? geometry.coordinates?.[0]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates?.[0]?.[0]
        : null;

  if (Array.isArray(coords) && coords.length) {
    let sumLat = 0;
    let sumLon = 0;
    let count = 0;
    coords.forEach((pair) => {
      if (Array.isArray(pair) && pair.length >= 2) {
        const [lon, lat] = pair;
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          sumLat += lat;
          sumLon += lon;
          count += 1;
        }
      }
    });
    if (count > 0) {
      return { lat: sumLat / count, lon: sumLon / count };
    }
  }
  return null;
}

async function ensureOutputDir() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

async function writeGeojson(features, regionsCount) {
  await ensureOutputDir();
  const payload = {
    type: 'FeatureCollection',
    meta: {
      generated: new Date().toISOString(),
      source: 'NINA/BBK via nina.api.proxy.bund.dev',
      regions: regionsCount,
      warnings: features.length
    },
    features
  };

  const tmpPath = `${OUTPUT_FILE}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2));
  await fs.rename(tmpPath, OUTPUT_FILE);
}

function buildFeature(warning) {
  return {
    type: 'Feature',
    geometry: warning.geometry ?? null,
    properties: {
      id: warning.id,
      rs: warning.rs,
      regionName: warning.regionName,
      provider: warning.provider,
      source: warning.source,
      category: warning.category,
      event: warning.event,
      headline: warning.headline,
      description: warning.description,
      severity: warning.severity,
      onset: warning.onset,
      effective: warning.effective,
      expires: warning.expires,
      centroid: warning.centroid || null
    }
  };
}

async function main() {
  const regions = await readRegionFile();
  const selectedRegions = regions.filter((r) => SELECTED_STATE_CODES.some((code) => r.rs?.startsWith(code)));
  log(`Bundesländer gewählt (${SELECTED_STATE_CODES.join(', ')}): ${selectedRegions.length} Regionen`);

  const warningsById = new Map();
  let successfulDashboards = 0;

  for (const region of selectedRegions) {
    const dashboard = await fetchDashboard(region.rs);
    if (!dashboard?.warnings || !Array.isArray(dashboard.warnings)) {
      continue;
    }
    successfulDashboards += 1;

    dashboard.warnings.forEach((entry) => {
      const identifier = entry?.id || entry?.identifier;
      if (!identifier) return;
      if (!warningsById.has(identifier)) {
        warningsById.set(identifier, { regions: [], dashboards: [] });
      }
      const item = warningsById.get(identifier);
      item.regions.push(region);
      item.dashboards.push(entry);
    });
  }

  const warnings = [];

  for (const [identifier, data] of warningsById.entries()) {
    const detail = await fetchWarningDetails(identifier);

    data.regions.forEach((region, idx) => {
      const dashboardWarning = data.dashboards[idx] || data.dashboards[0];
      const normalized = buildWarningEntry(identifier, region, dashboardWarning, detail);
      if (normalized) {
        warnings.push(normalized);
      }
    });
  }

  const uniqueWarnings = warnings.reduce((acc, w) => {
    const key = `${w.id}-${w.rs}`;
    if (!acc.map.has(key)) {
      acc.map.set(key, true);
      acc.list.push(w);
    }
    return acc;
  }, { map: new Map(), list: [] }).list;

  const features = uniqueWarnings.map(buildFeature);

  await writeGeojson(features, selectedRegions.length);

  if (features.length === 0) {
    log('Keine aktiven Warnungen gefunden – leere FeatureCollection geschrieben.');
  } else {
    log(`Schrieb ${features.length} Warnungen nach ${OUTPUT_FILE}`);
  }

  if (!successfulDashboards) {
    log('Keine NINA-Dashboards konnten geladen werden.');
    process.exit(1);
  }
}

main().catch((err) => {
  log(`Unerwarteter Fehler: ${err.message}`);
  process.exit(1);
});
