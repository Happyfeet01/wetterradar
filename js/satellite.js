// Satellitenbilder via DWD-WMS.
// Das Meteosat-Europabild wird bewusst als einzelnes WMS-GetMap-Bild geladen:
// Der DWD-Beispiellink für dieses Produkt nutzt eine feste EPSG:4326-Europe-
// Bounding-Box. Leaflet-WMS-Kacheln in WebMercator können für dieses Produkt je
// nach Server/Proxy leer bleiben; ein ImageOverlay zeigt die DWD-Ausgabe stabil.
import { DWD_SAT_BOUNDS, DWD_SAT_IMAGE, DWD_SAT_LAYER, DWD_SAT_WMS, DWD_SAT_WMS_FALLBACKS } from './config.js';

const DEFAULT_WMS_ENDPOINTS = [
  'https://maps.dwd.de/geoserver/dwd/ows?',
  'https://maps.dwd.de/geoserver/wms?',
  'https://brz-maps.dwd.de/geoserver/wms?',
];

let layer = null;
let endpointIndex = 0;
let endpoints = [];
let currentOpacity = 0.7;
let currentL = null;
let currentMap = null;

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

function getImageConfig(){
  const bounds = DWD_SAT_BOUNDS ?? [[22.99844049, -53.99411012], [76.99256049, 54.00310988]];
  const image = DWD_SAT_IMAGE ?? { width: 1024, height: 574 };
  return { bounds, width: image.width ?? 1024, height: image.height ?? 574 };
}

function buildGetMapUrl(endpoint, cacheBust = Date.now()){
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
  return `${normalizeWmsUrl(endpoint)}${params.toString()}`;
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

  // Bei echten Ladefehlern den nächsten bekannten DWD-Endpunkt versuchen. Ein
  // lokaler Proxy ist absichtlich nur Fallback, weil manche Proxy-Configs bei
  // Upstream-Fehlern ein valides, aber leeres 1x1-Bild mit HTTP 200 liefern.
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
  // Der WMS-Zeitpunkt wird serverseitig ausgewählt. Cache-Bust erzwingt bei
  // Radar-Zeitsprüngen/Animationen eine frische Prüfung des neuesten DWD-Bildes.
  if(!layer) return;
  const endpoint = endpoints[endpointIndex] ?? DEFAULT_WMS_ENDPOINTS[0];
  if(typeof layer.setUrl === 'function') layer.setUrl(buildGetMapUrl(endpoint));
  else if(currentL && currentMap) toggle(currentL, currentMap, true, currentOpacity);
}

export const __test = { buildEndpointList, buildGetMapUrl, getImageConfig, normalizeWmsUrl, DEFAULT_WMS_ENDPOINTS };
