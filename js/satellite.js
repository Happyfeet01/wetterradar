// Satellitenbilder via DWD-WMS.
// Das Meteosat-Europabild wird als WMS-GetMap-Bild geladen. Für die Animation
// nutzt der DWD/GeoServer die standardisierte WMS-Zeitdimension: GetCapabilities
// liefert verfügbare Zeitpunkte/Intervalle, GetMap akzeptiert diese über TIME=.
import { DWD_SAT_BOUNDS, DWD_SAT_IMAGE, DWD_SAT_LAYER, DWD_SAT_WMS, DWD_SAT_WMS_FALLBACKS } from './config.js';

const DEFAULT_WMS_ENDPOINTS = [
  'https://maps.dwd.de/geoserver/dwd/ows?',
  'https://maps.dwd.de/geoserver/wms?',
  'https://brz-maps.dwd.de/geoserver/wms?',
];

const SATELLITE_FRAME_INTERVAL_MS = 60 * 60 * 1000;
const FALLBACK_FRAME_COUNT = 24;

let layer = null;
let endpointIndex = 0;
let endpoints = [];
let frames = [];
let currentFrameIndex = 0;
let currentOpacity = 0.7;
let currentL = null;
let currentMap = null;

export async function loadSatellite(){
  endpoints = buildEndpointList(DWD_SAT_WMS, DWD_SAT_WMS_FALLBACKS);
  frames = [];

  for (const endpoint of endpoints) {
    try {
      const discovered = await fetchSatelliteFrames(endpoint);
      if (discovered.length) {
        frames = discovered;
        currentFrameIndex = frames.length - 1;
        return frames;
      }
    } catch (err) {
      console.warn('DWD-Satellitenzeiten konnten nicht geladen werden:', endpoint, err);
    }
  }

  frames = buildFallbackHourlyFrames();
  currentFrameIndex = frames.length - 1;
  return frames;
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
  const bounds = DWD_SAT_BOUNDS ?? [[22.99844049, -53.99411012], [76.99256049, 54.00310988]];
  const image = DWD_SAT_IMAGE ?? { width: 1024, height: 574 };
  return { bounds, width: image.width ?? 1024, height: image.height ?? 574 };
}

function buildGetMapUrl(endpoint, cacheBust = Date.now(), timeIso = getCurrentFrame()?.iso){
  const { bounds, width, height } = getImageConfig();
  const [[south, west], [north, east]] = bounds;
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetMap',
    layers: DWD_SAT_LAYER,
    styles: '',
    format: 'image/png',
    transparent: 'true',
    srs: 'EPSG:4326',
    bbox: [west, south, east, north].join(','),
    width: String(width),
    height: String(height),
    _t: String(cacheBust),
  });
  if (timeIso) params.set('time', timeIso);
  return `${normalizeWmsUrl(endpoint)}${params.toString()}`;
}

function buildGetCapabilitiesUrl(endpoint){
  const params = new URLSearchParams({ service: 'WMS', version: '1.1.1', request: 'GetCapabilities' });
  return `${normalizeWmsUrl(endpoint)}${params.toString()}`;
}

async function fetchSatelliteFrames(endpoint){
  const res = await fetch(buildGetCapabilitiesUrl(endpoint), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseSatelliteTimes(xml).map(iso => ({ time: Date.parse(iso) / 1000, iso }));
}

function parseSatelliteTimes(xml){
  const layerPattern = /<Layer\b[\s\S]*?<Name>\s*dwd:Satellite_meteosat_1km_euat_rgb_day_hrv_and_night_ir108_3h\s*<\/Name>[\s\S]*?<\/Layer>/i;
  const layerXml = xml.match(layerPattern)?.[0] || '';
  if (!layerXml) return [];

  const times = [...layerXml.matchAll(/<(?:Extent|Dimension)\b[^>]*name=["']time["'][^>]*>([\s\S]*?)<\/(?:Extent|Dimension)>/gi)]
    .flatMap(match => expandTimeList(decodeXmlEntities(match[1])));
  return [...new Set(times)].filter(iso => Number.isFinite(Date.parse(iso))).sort((a, b) => Date.parse(a) - Date.parse(b));
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
  if (!Number.isFinite(start) || !Number.isFinite(end) || !step) return [];
  const values = [];
  for (let t = start; t <= end && values.length < 240; t += step) values.push(new Date(t).toISOString());
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

function buildFallbackHourlyFrames(now = Date.now()){
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
  if (!frames.length || !Number.isFinite(timeUnix)) return currentFrameIndex;
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
    attribution: 'Satellit: EUMETSAT / DWD (CC BY 4.0)'
  });
}

function addLayerWithFallback(L, map, opacity){
  if (!endpoints.length) endpoints = buildEndpointList(DWD_SAT_WMS, DWD_SAT_WMS_FALLBACKS);

  const endpoint = endpoints[endpointIndex] ?? DEFAULT_WMS_ENDPOINTS[0];
  layer = createLayer(L, buildGetMapUrl(endpoint), opacity).addTo(map);

  layer.once('error', ()=>{
    if(!layer) return;
    if(endpointIndex >= endpoints.length - 1) return;
    map.removeLayer(layer);
    endpointIndex += 1;
    addLayerWithFallback(L, map, opacity);
  });
}

export function toggle(L, map, on, opacity=0.7){
  currentL = L;
  currentMap = map;
  currentOpacity = opacity;
  if(on){
    if(layer) map.removeLayer(layer);
    endpointIndex = 0;
    addLayerWithFallback(L, map, opacity);
  }else if(layer){
    map.removeLayer(layer);
    layer = null;
    endpointIndex = 0;
  }
}

export function setOpacity(val){
  currentOpacity = val;
  if(layer) layer.setOpacity(val);
}

export function syncTo(timeUnix){
  if(!layer) return;
  currentFrameIndex = findNearestFrameIndex(timeUnix);
  const endpoint = endpoints[endpointIndex] ?? DEFAULT_WMS_ENDPOINTS[0];
  if(typeof layer.setUrl === 'function') layer.setUrl(buildGetMapUrl(endpoint));
  else if(currentL && currentMap) toggle(currentL, currentMap, true, currentOpacity);
}

export const __test = {
  DEFAULT_WMS_ENDPOINTS,
  SATELLITE_FRAME_INTERVAL_MS,
  buildEndpointList,
  buildFallbackHourlyFrames,
  buildGetCapabilitiesUrl,
  buildGetMapUrl,
  expandTimeList,
  getImageConfig,
  normalizeWmsUrl,
  parseIsoPeriodMs,
  parseSatelliteTimes,
};
