// Satellitenbilder via DWD-WMS.
// Die frei sichtbaren DWD-Satellitenprodukte basieren auf EUMETSAT-Daten und
// werden als OGC-WMS-Bildlayer veröffentlicht. Die Open-Data-Verzeichnisse
// unter opendata.dwd.de enthalten ergänzend Rohprodukte (z. B. NetCDF), die für
// den Browser-Layer nicht direkt als Kartenkacheln geeignet sind.
import { DWD_SAT_LAYER, DWD_SAT_WMS, DWD_SAT_WMS_FALLBACKS } from './config.js';

const DEFAULT_WMS_ENDPOINTS = [
  'https://maps.dwd.de/geoserver/wms?',
  'https://brz-maps.dwd.de/geoserver/wms?',
];

let layer = null;
let endpointIndex = 0;
let endpoints = [];

export async function loadSatellite(){
  // DWD WMS benötigt kein Vorab-Laden von Frames – der Layer zeigt immer den
  // neuesten vom DWD veröffentlichten Zeitschritt des Satellitenprodukts.
  endpoints = buildEndpointList(DWD_SAT_WMS, DWD_SAT_WMS_FALLBACKS);
  return [];
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

function createLayer(L, url, opacity){
  return L.tileLayer.wms(url, {
    layers: DWD_SAT_LAYER,
    format: 'image/png',
    transparent: true,
    pane: 'cloudPane',
    opacity,
    version: '1.1.1',
    attribution: 'Satellit: EUMETSAT / DWD (CC BY 4.0)'
  });
}

function addLayerWithFallback(L, map, opacity){
  if (!endpoints.length) endpoints = buildEndpointList(DWD_SAT_WMS, DWD_SAT_WMS_FALLBACKS);

  const url = endpoints[endpointIndex] ?? DEFAULT_WMS_ENDPOINTS[0];
  layer = createLayer(L, url, opacity).addTo(map);

  // Wenn ein lokaler Proxy oder der primäre DWD-Host ausfällt, automatisch auf
  // den nächsten bekannten DWD-WMS-Endpunkt wechseln. Leaflet lädt WMS-Kacheln
  // als <img>, daher ist hierfür kein CORS-Read nötig.
  layer.once('tileerror', ()=>{
    if(!layer) return;
    if(endpointIndex >= endpoints.length - 1) return;
    map.removeLayer(layer);
    endpointIndex += 1;
    addLayerWithFallback(L, map, opacity);
  });
}

export function toggle(L, map, on, opacity=0.7){
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

export function setOpacity(val){ if(layer) layer.setOpacity(val); }

export function syncTo(timeUnix){
  // Der WMS-Zeitpunkt wird serverseitig ausgewählt. Cache-Bust erzwingt bei
  // Radar-Zeitsprüngen/Animationen eine frische Prüfung des neuesten DWD-Bildes.
  if(!layer) return;
  layer.setParams({ _t: Date.now() });
}

export const __test = { buildEndpointList, normalizeWmsUrl, DEFAULT_WMS_ENDPOINTS };
