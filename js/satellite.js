// Satellitenbilder via EUMETView (EUMETSAT WMS).
// Aktuelle Bilder werden immer auf den neuesten im WMS-Zeitindex gemeldeten
// Zeitpunkt gepinnt. Das vermeidet uneindeutiges "Latest" ohne time-Parameter.
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
const DISCOVERY_REFRESH_MS = 5 * 60 * 1000;
const CURRENT_SYNC_WINDOW_MS = 45 * 60 * 1000;
const STALE_TIME_INDEX_MS = 2 * 60 * 60 * 1000;

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
let lastRequestedUrl = null;
let hasDiscoveredFrames = false;

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

function normalizeIsoTime(value){
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function toSatelliteFrame(value){
  const rawIso = typeof value === 'string' ? value : value?.iso;
  const iso = normalizeIsoTime(rawIso);
  if (!iso) return null;
  return { time: Date.parse(iso) / 1000, iso };
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

function getNewestFrame(){
  return frames.at(-1) ?? null;
}

function findNearestFrameIndex(timeUnix){
  if (!frames.length) return 0;
  if (!Number.isFinite(timeUnix)) return frames.length - 1;

  let nearest = 0;
  let nearestDistance = Infinity;
  frames.forEach((frame, i) => {
    if (!Number.isFinite(frame?.time)) return;
    const distance = Math.abs(frame.time - timeUnix);
    if (distance < nearestDistance) {
      nearest = i;
      nearestDistance = distance;
    }
  });
  return nearest;
}

function isNearCurrentTime(timeUnix, nowMs = Date.now()){
  if (!Number.isFinite(timeUnix)) return true;
  return Math.abs(nowMs - timeUnix * 1000) <= CURRENT_SYNC_WINDOW_MS;
}

function buildGetMapUrl(endpoint, timeIso = getCurrentFrame()?.iso, { layerName = EUMETVIEW_SAT_LAYER } = {}){
  const { bounds, width, height } = getImageConfig();
  const [[south, west], [north, east]] = bounds;
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: layerName,
    styles: '',
    format: 'image/png',
    transparent: 'true',
    crs: 'EPSG:4326',
    // WMS 1.3.0 + EPSG:4326 nutzt latitude/longitude als Achsenreihenfolge.
    bbox: [south, west, north, east].join(','),
    width: String(width),
    height: String(height),
  });

  if (timeIso) params.set('time', timeIso);
  return `${normalizeWmsUrl(endpoint)}${params.toString()}`;
}

function activeFrame(nowMs = Date.now()){
  if (isNearCurrentTime(lastSyncTimeUnix, nowMs)) {
    return hasDiscoveredFrames ? getNewestFrame() : null;
  }
  return getCurrentFrame();
}

function buildActiveGetMapUrl(endpoint, nowMs = Date.now()){
  const frame = activeFrame(nowMs);
  if (!frame?.iso) return null;
  return buildGetMapUrl(endpoint, frame.iso);
}

function buildGetCapabilitiesUrl(endpoint){
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetCapabilities'
  });
  return `${normalizeWmsUrl(endpoint)}${params.toString()}`;
}

function escapeRegExp(value){
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeXmlEntities(value){
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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

function expandTimeList(value){
  return value.split(',').map(part => part.trim()).filter(Boolean).flatMap(part => {
    const pieces = part.split('/').map(piece => piece.trim());
    if (pieces.length !== 3) return [normalizeIsoTime(part)].filter(Boolean);
    return expandTimeInterval(pieces[0], pieces[1], pieces[2]);
  });
}

function extractLayerXml(xml, layerName = EUMETVIEW_SAT_LAYER){
  if (typeof xml !== 'string' || !xml) return '';
  const escapedLayer = escapeRegExp(layerName);
  const nameMatch = new RegExp(`<Name>\\s*${escapedLayer}\\s*<\\/Name>`, 'i').exec(xml);
  if (!nameMatch) return '';

  const stack = [];
  const tagPattern = /<\/?Layer\b[^>]*>/gi;
  tagPattern.lastIndex = 0;
  let match;
  while ((match = tagPattern.exec(xml)) && match.index < nameMatch.index) {
    if (/^<\/Layer/i.test(match[0])) stack.pop();
    else stack.push(match.index);
  }

  const start = stack.at(-1);
  if (!Number.isFinite(start)) return '';

  tagPattern.lastIndex = start;
  let depth = 0;
  while ((match = tagPattern.exec(xml))) {
    if (/^<\/Layer/i.test(match[0])) {
      depth -= 1;
      if (depth === 0) return xml.slice(start, tagPattern.lastIndex);
    } else {
      depth += 1;
    }
  }
  return '';
}

function parseSatelliteTimes(xml, layerName = EUMETVIEW_SAT_LAYER){
  const layerXml = extractLayerXml(xml, layerName);
  if (!layerXml) return [];

  const times = [...layerXml.matchAll(/<(?:Extent|Dimension)\b[^>]*name=["']time["'][^>]*>([\s\S]*?)<\/(?:Extent|Dimension)>/gi)]
    .flatMap(match => expandTimeList(decodeXmlEntities(match[1])));
  return [...new Set(times)]
    .filter(iso => Number.isFinite(Date.parse(iso)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .slice(-MAX_CAPABILITY_FRAMES);
}

async function fetchSatelliteFrames(endpoint){
  const res = await fetchWithTimeout(buildGetCapabilitiesUrl(endpoint), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseSatelliteTimes(xml).map(toSatelliteFrame).filter(Boolean);
}

function newestDiscoveredAgeMs(nowMs = Date.now()){
  if (!hasDiscoveredFrames) return Infinity;
  const newest = getNewestFrame();
  if (!Number.isFinite(newest?.time)) return Infinity;
  return Math.max(0, nowMs - newest.time * 1000);
}

function formatUtc(iso){
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function satelliteStatusText(nowMs = Date.now()){
  if (!enabled) return 'aus';
  const frame = activeFrame(nowMs);
  if (!frame) return 'EUMETView · Zeitindex nicht verfügbar';
  const time = formatUtc(frame.iso);
  if (isNearCurrentTime(lastSyncTimeUnix, nowMs) && newestDiscoveredAgeMs(nowMs) > STALE_TIME_INDEX_MS) {
    return `EUMETView · ${time} (Zeitindex alt)`;
  }
  return time ? `EUMETView · ${time}` : 'EUMETView';
}

export async function loadSatellite({ discover = false, force = false } = {}){
  endpoints = buildEndpointList(EUMETVIEW_WMS, EUMETVIEW_WMS_FALLBACKS);
  if (!frames.length) {
    frames = buildFallbackFrames();
    currentFrameIndex = findNearestFrameIndex(lastSyncTimeUnix);
  }

  // Boot-Aufruf: absichtlich keinerlei WMS-Request.
  if (!discover) {
    setUiStatus(enabled ? satelliteStatusText() : 'bei Bedarf');
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
          hasDiscoveredFrames = true;
          endpointIndex = i;
          currentFrameIndex = findNearestFrameIndex(lastSyncTimeUnix);
          lastError = null;
          return frames;
        }
        discoveryError = new Error(`Keine Satellitenzeiten in GetCapabilities: ${endpoint}`);
      } catch (err) {
        discoveryError = err;
        console.warn('EUMETView-Satellitenzeiten konnten nicht geladen werden:', endpoint, err);
      }
    }

    hasDiscoveredFrames = false;
    lastError = discoveryError;
    return frames;
  })().finally(() => {
    lastDiscoveryAt = Date.now();
    discoveryPromise = null;
    if (enabled) setUiStatus(satelliteStatusText());
  });

  return discoveryPromise;
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

function removeCurrentLayer(){
  if (layer && currentMap?.hasLayer(layer)) currentMap.removeLayer(layer);
  layer = null;
  lastRequestedUrl = null;
}

function endpointOrder(){
  if (!endpoints.length) return [];
  return [endpointIndex, ...endpoints.map((_, i) => i)]
    .filter((value, index, all) => value >= 0 && value < endpoints.length && all.indexOf(value) === index);
}

async function addLayerWithFallback(L, map, opacity){
  if (!enabled) return false;
  if (!endpoints.length) endpoints = buildEndpointList(EUMETVIEW_WMS, EUMETVIEW_WMS_FALLBACKS);

  const initialUrl = buildActiveGetMapUrl(endpoints[endpointIndex] ?? endpoints[0]);
  if (!initialUrl) {
    lastError = new Error('Kein bestätigter EUMETView-Zeitpunkt verfügbar');
    setUiStatus('EUMETView · Zeitindex nicht verfügbar');
    return false;
  }

  let imageError = null;
  for (const i of endpointOrder()) {
    if (!enabled) return false;

    const endpoint = endpoints[i];
    const url = buildActiveGetMapUrl(endpoint);
    if (!url) continue;
    const candidate = createLayer(L, url, opacity);
    layer = candidate;

    const loaded = await new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        candidate.off('load', onLoad);
        candidate.off('error', onError);
        resolve(result);
      };
      const fail = err => {
        imageError = err;
        if (map.hasLayer(candidate)) map.removeLayer(candidate);
        if (layer === candidate) layer = null;
        finish(false);
      };
      const onLoad = () => finish(true);
      const onError = () => fail(new Error(`WMS-Bildfehler: ${endpoint}`));
      const timer = setTimeout(() => fail(new Error(`Bild-Timeout nach ${IMAGE_TIMEOUT_MS} ms`)), IMAGE_TIMEOUT_MS);

      candidate.on('load', onLoad);
      candidate.on('error', onError);
      candidate.addTo(map);
    });

    if (loaded && enabled && layer === candidate) {
      endpointIndex = i;
      lastRequestedUrl = url;
      lastError = null;
      setUiStatus(satelliteStatusText());
      return true;
    }
  }

  lastError = imageError ?? lastError;
  console.warn('EUMETView-Satellitenbild konnte nicht geladen werden:', lastError);
  setUiStatus('nicht verfügbar');
  return false;
}

export async function toggle(L, map, on, opacity = 0.7){
  currentL = L;
  currentMap = map;
  currentOpacity = opacity;
  enabled = Boolean(on);

  if (!enabled) {
    removeCurrentLayer();
    endpointIndex = 0;
    setUiStatus('aus');
    return false;
  }

  if (!frames.length) frames = buildFallbackFrames();
  removeCurrentLayer();
  endpointIndex = 0;
  setUiStatus('lädt…');

  await loadSatellite({ discover: true, force: true });
  if (!enabled) return false;
  if (!hasDiscoveredFrames) {
    setUiStatus('EUMETView · Zeitindex nicht verfügbar');
    return false;
  }

  currentFrameIndex = findNearestFrameIndex(lastSyncTimeUnix);
  return addLayerWithFallback(L, map, opacity);
}

export function setOpacity(val){
  currentOpacity = val;
  if (layer) layer.setOpacity(val);
}

function watchLayerUpdate(candidate){
  const cleanup = () => {
    candidate.off('load', onLoad);
    candidate.off('error', onError);
  };
  const onLoad = () => {
    cleanup();
    if (layer !== candidate) return;
    lastError = null;
    setUiStatus(satelliteStatusText());
  };
  const onError = () => {
    cleanup();
    if (layer !== candidate) return;
    lastError = new Error('EUMETView-Satellitenupdate fehlgeschlagen');
    setUiStatus('EUMETView · Updatefehler');
  };
  candidate.on('load', onLoad);
  candidate.on('error', onError);
}

export function syncTo(timeUnix){
  if (Number.isFinite(timeUnix)) lastSyncTimeUnix = timeUnix;
  currentFrameIndex = findNearestFrameIndex(lastSyncTimeUnix);
  if (!layer) return;

  const endpoint = endpoints[endpointIndex] ?? DEFAULT_WMS_ENDPOINTS[0];
  const url = buildActiveGetMapUrl(endpoint);
  if (!url) {
    lastError = new Error('Kein bestätigter EUMETView-Zeitpunkt verfügbar');
    setUiStatus('EUMETView · Zeitindex nicht verfügbar');
    return;
  }
  if (url === lastRequestedUrl) {
    setUiStatus(satelliteStatusText());
    return;
  }

  if (typeof layer.setUrl === 'function') {
    lastRequestedUrl = url;
    watchLayerUpdate(layer);
    layer.setUrl(url);
  } else if (currentL && currentMap) {
    void toggle(currentL, currentMap, true, currentOpacity);
  }
}

export function getLastError(){ return lastError; }

export const __test = {
  DEFAULT_WMS_ENDPOINTS,
  SATELLITE_FRAME_INTERVAL_MS,
  FALLBACK_FRAME_COUNT,
  CAPABILITIES_TIMEOUT_MS,
  IMAGE_TIMEOUT_MS,
  DISCOVERY_REFRESH_MS,
  CURRENT_SYNC_WINDOW_MS,
  STALE_TIME_INDEX_MS,
  buildEndpointList,
  buildFallbackFrames,
  buildGetCapabilitiesUrl,
  buildGetMapUrl,
  buildActiveGetMapUrl,
  expandTimeInterval,
  expandTimeList,
  extractLayerXml,
  fetchWithTimeout,
  findNearestFrameIndex,
  getImageConfig,
  isNearCurrentTime,
  normalizeIsoTime,
  normalizeWmsUrl,
  parseIsoPeriodMs,
  parseSatelliteTimes,
  toSatelliteFrame,
};
