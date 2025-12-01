#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fetchFn = globalThis.fetch
  ? (...args) => globalThis.fetch(...args)
  : async (...args) => {
      const { default: fetch } = await import('node-fetch');
      return fetch(...args);
    };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DASHBOARD_BASE = process.env.NINA_API_BASE || 'https://nina.api.proxy.bund.dev/api31';
const ASSETS_BASE = process.env.NINA_ASSETS_BASE || 'https://nina.api.proxy.bund.dev/assets';
const DEFAULT_REGION_FILE = path.resolve(__dirname, 'Regionalschluessel_2021-07-31.json');
const OUTPUT_FILE = path.resolve(process.env.NINA_OUTPUT_FILE || '/var/www/wetterradar/warnings/nina.geojson');
const USER_AGENT = process.env.NINA_USER_AGENT || 'wetterradar/1.0';
const REQUEST_TIMEOUT = Math.max(5_000, Number(process.env.NINA_REQUEST_TIMEOUT_MS) || 10_000);
const RETRY_DELAY = Math.max(250, Number(process.env.NINA_RETRY_DELAY_MS) || 750);

function log(message, ...rest) {
  console.log(`[nina] ${message}`, ...rest);
}

function warn(message, ...rest) {
  console.warn(`[nina] ${message}`, ...rest);
}

function toIso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function fetchJson(url, { allow404 = false, retries = 1 } = {}) {
  let attempt = 0;
  while (true) {
    const { signal, cancel } = toAbortSignal(REQUEST_TIMEOUT);
    try {
      const res = await fetchFn(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT
        },
        cache: 'no-store',
        signal
      });

      if (allow404 && res.status === 404) {
        cancel();
        return null;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
      }

      const data = await res.json();
      cancel();
      return data;
    } catch (err) {
      cancel();
      attempt += 1;
      if (attempt > retries) {
        throw err;
      }
      warn(`Fehler bei Anfrage ${url} (Versuch ${attempt}/${retries}): ${err.message}. Wiederhole …`);
      await sleep(RETRY_DELAY);
    }
  }
}

function normalizeArsEntry(entry) {
  if (typeof entry === 'string' || typeof entry === 'number') {
    const value = String(entry).trim();
    return value ? value : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const candidate =
    entry.rs ||
    entry.RS ||
    entry.ARS ||
    entry.ars ||
    entry.ags ||
    entry.AGS ||
    entry.rs_full ||
    entry.RegionalSchluessel;
  if (!candidate) return null;
  const value = String(candidate).trim();
  return value || null;
}

function parseRegionalschluesel(json) {
  if (!json) return [];
  const values = Array.isArray(json) ? json : json?.data || [];
  if (!Array.isArray(values)) return [];
  const arsList = values
    .map(normalizeArsEntry)
    .filter((v) => typeof v === 'string' && v.length > 0);
  return Array.from(new Set(arsList));
}

async function loadArsList() {
  const sourceFile = process.env.NINA_ARS_FILE || DEFAULT_REGION_FILE;
  try {
    const raw = await fs.readFile(sourceFile, 'utf8');
    const json = JSON.parse(raw);
    const arsList = parseRegionalschluesel(json);
    if (arsList.length) {
      log(`Geladene Regionalschlüssel aus ${sourceFile}: ${arsList.length}`);
      return arsList;
    }
    warn(`Datei ${sourceFile} enthielt keine gültigen Regionalschlüssel.`);
  } catch (err) {
    warn(`Konnte ${sourceFile} nicht laden: ${err.message}`);
  }

  const remoteUrl = `${ASSETS_BASE}/regionalschluessel_2021-07-31.json`;
  try {
    const json = await fetchJson(remoteUrl, { retries: 1 });
    const arsList = parseRegionalschluesel(json);
    if (arsList.length) {
      log(`Geladene Regionalschlüssel aus Remote ${remoteUrl}: ${arsList.length}`);
      return arsList;
    }
    warn(`Remote-Datei ${remoteUrl} enthielt keine gültigen Regionalschlüssel.`);
  } catch (err) {
    warn(`Regionalschlüssel konnten nicht aus dem Netz geladen werden: ${err.message}`);
  }

  warn('Keine Regionalschlüssel gefunden – es werden keine Dashboards abgefragt.');
  return [];
}

function isCancelled(entry) {
  const status = (entry?.status || entry?.payload?.status || entry?.payload?.msgType || '').toString().toLowerCase();
  return status.includes('cancel');
}

function parseDate(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function isExpired(entry) {
  const expiry =
    parseDate(entry?.expires) ||
    parseDate(entry?.expiry) ||
    parseDate(entry?.payload?.expires) ||
    parseDate(entry?.payload?.expiry) ||
    parseDate(entry?.payload?.info?.[0]?.expires) ||
    parseDate(entry?.payload?.data?.expires);
  return expiry !== null && expiry < Date.now();
}

function extractIdentifier(entry) {
  const candidate =
    entry?.identifier ||
    entry?.id ||
    entry?.payload?.identifier ||
    entry?.payload?.id ||
    entry?.hash ||
    entry?.payload?.hash;
  return candidate ? String(candidate) : null;
}

function collectIdentifiersFromDashboard(data) {
  if (!Array.isArray(data)) return [];
  const ids = [];
  for (const entry of data) {
    if (isCancelled(entry) || isExpired(entry)) continue;
    const id = extractIdentifier(entry);
    if (id) ids.push(id);
  }
  return ids;
}

async function fetchDashboard(ars) {
  const url = `${DASHBOARD_BASE}/dashboard/${encodeURIComponent(ars)}.json`;
  try {
    const json = await fetchJson(url, { retries: 1, allow404: true });
    if (!json) {
      warn(`Dashboard ${ars} liefert 404 – wird übersprungen.`);
      return [];
    }
    if (!Array.isArray(json)) {
      warn(`Unerwartetes Dashboard-Format für ${ars}`);
      return [];
    }
    return json;
  } catch (err) {
    warn(`Dashboard ${ars} konnte nicht geladen werden: ${err.message}`);
    return [];
  }
}

async function fetchWarningDetails(identifier) {
  const url = `${DASHBOARD_BASE}/warnings/${encodeURIComponent(identifier)}.json`;
  try {
    return await fetchJson(url, { retries: 1, allow404: true });
  } catch (err) {
    warn(`Details für ${identifier} konnten nicht geladen werden: ${err.message}`);
    return null;
  }
}

async function fetchWarningGeoJson(identifier) {
  const url = `${DASHBOARD_BASE}/warnings/${encodeURIComponent(identifier)}.geojson`;
  try {
    const json = await fetchJson(url, { retries: 1, allow404: true });
    if (!json) {
      warn(`Keine GeoJSON-Daten für ${identifier} (404).`);
      return null;
    }
    if (json.type === 'FeatureCollection' && Array.isArray(json.features)) {
      return json.features;
    }
    warn(`Unerwartetes GeoJSON-Format für ${identifier}`);
    return null;
  } catch (err) {
    warn(`GeoJSON für ${identifier} konnte nicht geladen werden: ${err.message}`);
    return null;
  }
}

function pick(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return null;
}

function extractInfo(detail) {
  const info = Array.isArray(detail?.info) ? detail.info[0] : detail?.payload?.info?.[0] || detail?.payload?.data || detail?.payload || detail;
  return info || {};
}

function buildProperties(identifier, detail, featureProperties = {}) {
  const info = extractInfo(detail);
  const properties = {
    identifier,
    headline: String(pick(info.headline, featureProperties.headline, featureProperties.title, '')),
    description: String(pick(info.description, info.instruction, featureProperties.description, '')),
    severity: String(pick(info.severity, featureProperties.severity, 'unknown')),
    urgency: pick(info.urgency, featureProperties.urgency) ?? null,
    onset: toIso(pick(info.onset, info.sent, info.effective, featureProperties.onset)) || null,
    expires: toIso(pick(info.expires, info.expiry, featureProperties.expires)) || null,
    sender: pick(info.sender, detail?.sender, featureProperties.sender, featureProperties.provider) || null,
    source: 'NINA'
  };
  return properties;
}

function isValidGeometry(feature) {
  const geom = feature?.geometry;
  if (!geom || typeof geom !== 'object') return false;
  if (!('coordinates' in geom)) return false;
  if (!Array.isArray(geom.coordinates) || geom.coordinates.length === 0) return false;
  return typeof geom.type === 'string' && geom.type.length > 0;
}

function mergeFeatures(identifier, detail, geoFeatures) {
  const merged = [];
  for (const feature of geoFeatures) {
    if (!isValidGeometry(feature)) {
      continue;
    }
    const properties = buildProperties(identifier, detail, feature.properties || {});
    merged.push({
      type: 'Feature',
      geometry: feature.geometry,
      properties
    });
  }
  return merged;
}

async function writeAtomic(filePath, payload) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `${GEOJSON_FILENAME}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.chmod(tmpPath, 0o644);
  await fs.rename(tmpPath, filePath);
}

async function buildFeatureCollection(features) {
  return {
    type: 'FeatureCollection',
    features
  };
}

async function main() {
  const arsList = await loadArsList();
  const identifiers = new Set();

  for (const ars of arsList) {
    const dashboard = await fetchDashboard(ars);
    collectIdentifiersFromDashboard(dashboard).forEach((id) => identifiers.add(id));
  }

  if (!identifiers.size) {
    warn('Keine aktiven Warnungen gefunden – es wird eine leere FeatureCollection geschrieben.');
    const payload = await buildFeatureCollection([]);
    await writeAtomic(OUTPUT_FILE, payload);
    log(`Leere Datei geschrieben: ${OUTPUT_FILE}`);
    return;
  }

  const allFeatures = [];
  for (const id of identifiers) {
    const [detail, geoFeatures] = await Promise.all([fetchWarningDetails(id), fetchWarningGeoJson(id)]);
    if (!geoFeatures || !geoFeatures.length) {
      warn(`Warnung ${id} ohne GeoJSON – übersprungen.`);
      continue;
    }
    const merged = mergeFeatures(id, detail, geoFeatures);
    if (merged.length) {
      allFeatures.push(...merged);
    }
  }

  const payload = await buildFeatureCollection(allFeatures);
  await writeAtomic(OUTPUT_FILE, payload);
  log(`Geschriebene Features: ${allFeatures.length} → ${OUTPUT_FILE}`);
}

main().catch((err) => {
  warn(`Unerwarteter Fehler: ${err.message}`);
});
