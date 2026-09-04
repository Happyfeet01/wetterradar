// Satellitenbilder via EUMETView (EUMETSAT WMS).
// Wichtig: Der Satellit liegt nicht im kritischen Startpfad. Beim Boot werden nur
// lokale Fallback-Zeitpunkte vorbereitet; Netzwerkzugriffe beginnen erst, wenn
// der Nutzer den Satelliten-Layer einschaltet.
import {
  EUMETVIEW_SAT_BOUNDS,
  EUMETVIEW_SAT_IMAGE,
  EUMETVIEW_SAT_LAYER,
  EUMETVIEW_WMS,
  EUMETVIEW_WMS_FALLBACKS,
} from './config.js';

const DEFAULT_WMS_ENDPOINTS = [
  '/eumetview/wms?',
  'https://view.eumetsat.int/geoserver/wms?',
];
const SATELLITE_FRAME_INTERVAL_MS = 10 * 60 * 1000;
const FALLBACK_FRAME_COUNT = 24;
const MAX_CAPABILITY_FRAMES = 240;
const CAPABILITIES_TIMEOUT_MS = 8000;
const IMAGE_TIMEOUT_MS = 12000;
const DISCOVERY_REFRESH_MS = 10 * 60 * 1000;

let layer = null;
let endpointIndex = 0;
let endpoints = [];
let frames = [];
let currentFrameIndex = 0;
let currentOpacity = 0.7;
let currentL = null;
let currentMap = null;
let enabled = false;
let lastSyncTimeUnix = null;
let discoveryPromise = null;
let lastDiscoveryAt = 0;
let lastError = null;

function setUiStatus(text){
  if (typeof document === 'undefined') return;
  let el = document.getElementById('lblSatelliteInfo');
  if (!el) {
    const checkbox = document.getElementById('chkClouds');
    if (!checkbox?.parentElement) return;
    el = document.createElement('span');
    el.id = 'lblSatelliteInfo';
    el.className = 'hint';
    checkbox.parentElement.append(el);
  }
  el.textContent = text;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = CAPABILITIES_TIMEOUT_MS){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`Timeout nach ${timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadSatellite({ discover = false, force = false } = {}){
  endpoints = buildEndpointList(EUMETVIEW_WMS, EUMETVIEW_WMS_FALLBACKS);
  if (!frames.length) {
    frames = buildFallbackFrames();
    currentFrameIndex = findNearestFrameIndex(lastSyncTimeUnix);
  }

  // Boot-Aufruf: absichtlich keinerlei WMS-Request.
  if (!discover) {
    setUiStatus('bei Bedarf');
    return frames;
  }

  if (!force && lastDiscoveryAt && Date.now() - lastDiscoveryAt < DISCOVERY_REFRESH_MS) return frames;
  if (discoveryPromise) return discoveryPromise;

  discoveryPromise = (async () => {
    let discoveryError = null;
    for (let i = 0; i < endpoints.length; i += 1) {
      const endpoint = endpoints[i];
      try {
        const discovered = await fetchSatelliteFrames(endpoint);
        if (discovered.length) {
          frames = discovered.slice(-MAX_CAPABILITY_FRAMES);
          endpointIndex = i;
          currentFrameIndex = findNearestFrameIndex(lastSyncTimeUnix);
          lastDiscoveryAt = Date.now();
          lastError = null;
          return frames;
        }
      } catch (err) {
        discoveryError = err;
        console.warn('EUMETView-Satellitenzeiten konnten nicht geladen werden:', endpoint, err);
      }
    }

    // Zeit-Ermittlung ist optional: der Layer kann mit den lokal erzeugten
    // 10-Minuten-Zeitpunkten bzw. dem neuesten Bild weiterarbeiten.
    lastError = discoveryError;
    return frames;
  })().finally(() => { discoveryPromise = null; });

  return discoveryPromise;
}

function normalizeWmsUrl(url){
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.includes('?') ? trimmed : `${trimmed}?`;
}

function buildEndpointList(primary, fallbacks = []){
  const candidates = [primary, ...(Array.isArray(fallbacks) ? fallbacks : []), ...DEFAULT_WMS_ENDPOINTS]
    .map(normalizeWmsUrl)
    .filter(Boolean);
  return [...new Set(candidates)];
}

function getImageConfig(){
  const bounds = EUMETVIEW_SAT_BOUNDS ?? [[30, -13], [65, 40]];
  const image = EUMETVIEW_SAT_IMAGE ?? { width: 1200, height: 800 };
  return { bounds, width: image.width ?? 1200, height: image.height ?? 800 };
}

function buildGetMapUrl(endpoint, timeIso = getCurrentFrame()?.iso){
  const { bounds, width, height } = getImageConfig();
  const [[south, west], [north, east]] = bounds;
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: EUMETVIEW_SAT_LAYER,
    styles: '',
    format: 'image/png',
    transparent: 'true',
    crs: 'EPSG:4326',
    // WMS 1.3.0 + EPSG:4326 nutzt die Achsenreihenfolge latitude/longitude.
    bbox: [south, west, north, east].join(','),
    width: String(width),
    height: String(height),
  });
  if (timeIso) params.set('time', timeIso);
  return `${normalizeWmsUrl(endpoint)}${params.toString()}`;
}

function buildGetCapabilitiesUrl(endpoint){
  const params = new URLSearchParams({ service: 'WMS', version: '1.3.0', request: 'GetCapabilities' });
  return `${normalizeWmsUrl(endpoint)}${params.toString()}`;
}

async function fetchSatelliteFrames(endpoint){
  const res = await fetchWithTimeout(buildGetCapabilitiesUrl(endpoint), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseSatelliteTimes(xml);
}

function escapeRegExp(value){
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSatelliteTimes(xml, layerName = EUMETVIEW_SAT_LAYER){
  const escapedLayer = escapeRegExp(layerName);
  const layerPattern = new RegExp(`<Layer\\b[\\s\\S]*?<Name>\\s*${escapedLayer}\\s*<\\/Name>[\\s\\S]*?<\\/Layer>`, 'i');
  const layerXml = xml.match(layerPattern)?.[0] || '';
  if (!layerXml) return [];

  const times = [...layerXml.matchAll(/<(?:Extent|Dimension)\b[^>]*name=["']time["'][^>]*>([\s\S]*?)<\/(?:Extent|Dimension)>/gi)]
    .flatMap(match => expandTimeList(decodeXmlEntities(match[1])));
  return [...new Set(times)]
    .filter(iso => Number.isFinite(Date.parse(iso)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .slice(-MAX_CAPABILITY_FRAMES);
}

function decodeXmlEntities(value){
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function expandTimeList(value){
  return value.split(',').map(part => part.trim()).filter(Boolean).flatMap(part => {
    const pieces = part.split('/').map(piece => piece.trim());
    if (pieces.length !== 3) return [normalizeIsoTime(part)].filter(Boolean);
    return expandTimeInterval(pieces[0], pieces[1], pieces[2]);
  });
}

function expandTimeInterval(startRaw, endRaw, periodRaw){
  const start = Date.parse(startRaw);
  const end = Date.parse(endRaw);
  const step = parseIsoPeriodMs(periodRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !step || end < start) return [];

  const total = Math.floor((end - start) / step) + 1;
  const firstIndex = Math.max(0, total - MAX_CAPABILITY_FRAMES);
  const values = [];
  for (let i = firstIndex; i < total && values.length < MAX_CAPABILITY_FRAMES; i += 1) {
    values.push(new Date(start + i * step).toISOString());
  }
  return values;
}

function parseIsoPeriodMs(period){
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(period.trim());
  if (!match) return 0;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function normalizeIsoTime(value){
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function buildFallbackFrames(now = Date.now()){
  const end = Math.floor(now / SATELLITE_FRAME_INTERVAL_MS) * SATELLITE_FRAME_INTERVAL_MS;
  return Array.from({ length: FALLBACK_FRAME_COUNT }, (_, i) => {
    const timeMs = end - (FALLBACK_FRAME_COUNT - 1 - i) * SATELLITE_FRAME_INTERVAL_MS;
    return { time: timeMs / 1000, iso: new Date(timeMs).toISOString() };
  });
}

function getCurrentFrame(){
  return frames[currentFrameIndex] ?? null;
}

function findNearestFrameIndex(timeUnix){
  if (!frames.length) return 0;
  if (!Number.isFinite(timeUnix)) return frames.length - 1;
  let nearest = 0;
  let nearestDistance = Infinity;
  frames.forEach((frame, i) => {
    const distance = Math.abs(frame.time - timeUnix);
    if (distance < nearestDistance) { nearest = i; nearestDistance = distance; }
  });
  return nearest;
}

function createLayer(L, url, opacity){
  const { bounds } = getImageConfig();
  return L.imageOverlay(url, bounds, {
    pane: 'cloudPane',
    opacity,
    interactive: false,
    attribution: 'Satellit © EUMETSAT (EUMETView)'
  });
}

function addLayerWithFallback(L, map, opacity){
  if (!enabled) return Promise.resolve(false);
  if (!endpoints.length) endpoints = buildEndpointList(EUMETVIEW_WMS, EUMETVIEW_WMS_FALLBACKS);
  const endpoint = endpoints[endpointIndex] ?? DEFAULT_WMS_ENDPOINTS[0];
  const candidate = createLayer(L, buildGetMapUrl(endpoint), opacity);
  layer = candidate;

  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = err => {
      if (settled) return;
      if (layer === candidate && map.hasLayer(candidate)) map.removeLayer(candidate);
      if (layer === candidate) layer = null;
      if (!enabled) return finish(false);
      if (endpointIndex < endpoints.length - 1) {
        endpointIndex += 1;
        finish(addLayerWithFallback(L, map, opacity));
        return;
      }
      lastError = err;
      console.warn('EUMETView-Satellitenbild konnte nicht geladen werden:', err);
      setUiStatus('nicht verfügbar');
      finish(false);
    };

    const timer = setTimeout(() => fail(new Error(`Bild-Timeout nach ${IMAGE_TIMEOUT_MS} ms`)), IMAGE_TIMEOUT_MS);
    candidate.once('load', () => {
      if (!enabled || layer !== candidate) return finish(false);
      lastError = null;
      setUiStatus('EUMETView');
      finish(true);
    });
    candidate.once('error', () => fail(new Error(`WMS-Bildfehler: ${endpoint}`)));
    candidate.addTo(map);
  }).then(result => result instanceof Promise ? result : result);
}

export function toggle(L, map, on, opacity = 0.7){
  currentL = L;
  currentMap = map;
  currentOpacity = opacity;
  enabled = Boolean(on);

  if (!enabled) {
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    layer = null;
    endpointIndex = 0;
    setUiStatus('aus');
    return Promise.resolve(false);
  }

  if (!frames.length) {
    frames = buildFallbackFrames();
    currentFrameIndex = findNearestFrameIndex(lastSyncTimeUnix);
  }
  if (layer && map.hasLayer(layer)) map.removeLayer(layer);
  layer = null;
  endpointIndex = 0;
  setUiStatus('lädt…');

  // Bild sofort lazy laden. Die teurere GetCapabilities-Ermittlung läuft davon
  // entkoppelt und kann den Radar-/UI-Pfad nicht blockieren.
  const imageLoad = addLayerWithFallback(L, map, opacity);
  void loadSatellite({ discover: true }).then(() => {
    if (!enabled || !layer) return;
    currentFrameIndex = findNearestFrameIndex(lastSyncTimeUnix);
    const endpoint = endpoints[endpointIndex] ?? DEFAULT_WMS_ENDPOINTS[0];
    if (typeof layer.setUrl === 'function') layer.setUrl(buildGetMapUrl(endpoint));
  });
  return imageLoad;
}

export function setOpacity(val){
  currentOpacity = val;
  if(layer) layer.setOpacity(val);
}

export function syncTo(timeUnix){
  lastSyncTimeUnix = Number.isFinite(timeUnix) ? timeUnix : lastSyncTimeUnix;
  currentFrameIndex = findNearestFrameIndex(lastSyncTimeUnix);
  if(!layer) return;
  const endpoint = endpoints[endpointIndex] ?? DEFAULT_WMS_ENDPOINTS[0];
  if(typeof layer.setUrl === 'function') layer.setUrl(buildGetMapUrl(endpoint));
  else if(currentL && currentMap) void toggle(currentL, currentMap, true, currentOpacity);
}

export function getLastError(){ return lastError; }

export const __test = {
  DEFAULT_WMS_ENDPOINTS,
  SATELLITE_FRAME_INTERVAL_MS,
  FALLBACK_FRAME_COUNT,
  CAPABILITIES_TIMEOUT_MS,
  IMAGE_TIMEOUT_MS,
  buildEndpointList,
  buildFallbackFrames,
  buildGetCapabilitiesUrl,
  buildGetMapUrl,
  expandTimeInterval,
  expandTimeList,
  fetchWithTimeout,
  getImageConfig,
  normalizeWmsUrl,
  parseIsoPeriodMs,
  parseSatelliteTimes,
};
