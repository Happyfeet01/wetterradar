import { RV_API, RV_HOST_FALLBACK, RADAR_SIZE, RADAR_ZOOM_OFFSET, PLAY_FADE_MS } from './config.js';

const RADAR_FETCH_TIMEOUT_MS = 8000;
const RADAR_REFRESH_MS = 10 * 60 * 1000;

let RV_HOST = RV_HOST_FALLBACK;
let frames = [];
let idx = 0;
let curr = null, next = null;
let loadPromise = null;
let lastSuccessfulLoad = 0;
let lastError = null;
let lastPaintKey = null;

async function fetchWithTimeout(url, options = {}, timeoutMs = RADAR_FETCH_TIMEOUT_MS){
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

export async function loadRadar({ force = false } = {}){
  const nowMs = Date.now();
  if (!force && frames.length && lastSuccessfulLoad && nowMs - lastSuccessfulLoad < RADAR_REFRESH_MS) return frames;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const res = await fetchWithTimeout(RV_API, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
      const data = await res.json();

      RV_HOST = data.host || RV_HOST_FALLBACK;
      // Nowcast wurde von RainViewer eingestellt – nur noch Past-Frames verwenden.
      const incomingFrames = [...(data?.radar?.past ?? [])];
      if (!incomingFrames.length) throw new Error('RainViewer liefert keine Radar-Frames');

      frames = incomingFrames;
      lastSuccessfulLoad = Date.now();
      lastError = null;

      // Setze den Index auf den letzten Zeitpunkt, der nicht in der Zukunft liegt.
      const now = Date.now() / 1000;
      let latestPastIdx = -1;
      frames.forEach((frame, i) => {
        if (frame.time <= now && (latestPastIdx === -1 || frame.time > frames[latestPastIdx].time)) latestPastIdx = i;
      });
      idx = latestPastIdx >= 0 ? latestPastIdx : 0;
      return frames;
    } catch (err) {
      lastError = err;
      console.error('RainViewer weather-maps.json konnte nicht geladen werden:', err);
      // Bei einem Refresh-Fehler vorhandene Frames weiterverwenden.
      return frames;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

export function getFrames(){ return frames; }
export function getIndex(){ return idx; }
export function getLastError(){ return lastError; }
export function step(d){ if(!frames.length) return; idx = (idx + d + frames.length) % frames.length; }

function radarUrl(frame, ui){
  // RainViewer Free-Tier: nur noch Farbschema 8 (Universal Blue) verfügbar.
  const color = 8;
  const smooth = ui.chkSmooth.checked ? 1 : 0;
  const snow = 0;
  const host = (RV_HOST || RV_HOST_FALLBACK).replace(/\/+$/, '');
  let path = String(frame.path || '').replace(/^\/+/, '');
  if (!path.startsWith('v2/')) path = 'v2/radar/' + path;
  // Der Frame-Zeitstempel steckt bereits im RainViewer-Pfad. Kein zusätzlicher
  // Cache-Buster, damit Browser/CDN identische Tiles wiederverwenden können.
  return `${host}/${path}/${RADAR_SIZE}/{z}/{x}/{y}/${color}/${smooth}_${snow}.png`;
}

export function paint(L, map, ui, syncCloudsCb){
  const f = frames[idx];
  if(!f){
    if (ui?.lblTime) ui.lblTime.textContent = lastError ? 'Radar nicht verfügbar' : 'Keine Radardaten';
    return false;
  }

  const dt = new Date(f.time * 1000);
  ui.lblTime.textContent = dt.toLocaleString([], { dateStyle:'short', timeStyle:'short' });
  const op = Number(ui.rngOpacity.value);
  ui.lblOpacity.textContent = Math.round(op * 100) + '%';

  // Regelmäßige Refresh-Ticks dürfen denselben Frame nicht erneut als TileLayer
  // anlegen. Das spart unnötige RainViewer-Tile-Requests.
  const paintKey = `${f.time}|${f.path}|${ui.chkSmooth.checked ? 1 : 0}`;
  if (curr && paintKey === lastPaintKey) {
    curr.setOpacity(op);
    if (syncCloudsCb) syncCloudsCb(f.time);
    return true;
  }

  if(next){ map.removeLayer(next); next = null; }
  next = L.tileLayer(radarUrl(f, ui), {
    pane:'radarPane', tileSize:RADAR_SIZE, zoomOffset:RADAR_ZOOM_OFFSET,
    opacity:0, className:'rv-tiles',
    maxNativeZoom:7,
    updateWhenZooming:false, updateWhenIdle:true, keepBuffer:1,
    attribution:'Radar © RainViewer'
  }).addTo(map);
  lastPaintKey = paintKey;

  requestAnimationFrame(() => {
    if(!next) return;
    next.setOpacity(op);
    if(!curr){ curr = next; next = null; return; }
    const oldLayer = curr;
    const newLayer = next;
    oldLayer.setOpacity(0);
    setTimeout(() => {
      if (map.hasLayer(oldLayer)) map.removeLayer(oldLayer);
      curr = newLayer;
      if (next === newLayer) next = null;
    }, PLAY_FADE_MS + 40);
  });

  if (syncCloudsCb) syncCloudsCb(f.time);
  return true;
}

export const __test = {
  RADAR_FETCH_TIMEOUT_MS,
  RADAR_REFRESH_MS,
  fetchWithTimeout,
  radarUrl,
  reset(){
    RV_HOST = RV_HOST_FALLBACK;
    frames = [];
    idx = 0;
    curr = null;
    next = null;
    loadPromise = null;
    lastSuccessfulLoad = 0;
    lastError = null;
    lastPaintKey = null;
  },
};
