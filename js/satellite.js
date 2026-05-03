// Satellitenbilder via DWD WMS (ersetzt RainViewer IR, das seit 2025 eingestellt ist)
import { DWD_SAT_WMS, DWD_SAT_LAYER } from './config.js';

const DWD_SAT_WMS_FALLBACK = 'https://maps.dwd.de/geoserver/dwd/wms?';
const DWD_SAT_WMS_DIRECT = 'https://maps.dwd.de/geoserver/dwd/wms?';

let layer = null;
let usingFallbackHost = false;

export async function loadSatellite(){
  // DWD WMS benötigt kein Vorab-Laden von Frames –
  // der Layer zeigt immer den aktuellsten Stand.
  return [];
}

function createLayer(L, url, opacity){
  return L.tileLayer.wms(url, {
    layers: DWD_SAT_LAYER,
    format: 'image/png',
    transparent: true,
    pane: 'cloudPane',
    opacity,
    attribution: 'Satellit © DWD'
  });
}

function resolvePrimaryWmsUrl(){
  // Falls eine ältere Konfiguration noch auf den lokalen Proxy zeigt
  // (z. B. /dwd/sat/wms) und dieser nicht existiert (404), erzwingen wir
  // direkt den DWD-Host als Primärquelle.
  if (typeof DWD_SAT_WMS === 'string' && /^https?:\/\//i.test(DWD_SAT_WMS)){
    return DWD_SAT_WMS;
  }
  return DWD_SAT_WMS_DIRECT;
}

export function toggle(L, map, on, opacity=0.7){
  if(on){
    if(layer) map.removeLayer(layer);
    usingFallbackHost = false;
    layer = createLayer(L, resolvePrimaryWmsUrl(), opacity).addTo(map);

    // Wenn der same-origin Proxy ausfällt (z.B. 5xx vom Upstream),
    // wechsle automatisch auf den direkten DWD-Endpunkt.
    // Leaflet lädt Kacheln als <img>, daher ist hierfür kein CORS-Read nötig.
    // Damit bleibt das Satelliten-Layer auch bei Proxy-/Nginx-Störungen nutzbar.
    layer.once('tileerror', ()=>{
      if(!layer || usingFallbackHost) return;
      map.removeLayer(layer);
      usingFallbackHost = true;
      layer = createLayer(L, DWD_SAT_WMS_FALLBACK, opacity).addTo(map);
    });
  }else if(layer){
    map.removeLayer(layer); layer=null;
    usingFallbackHost = false;
  }
}

export function setOpacity(val){ if(layer) layer.setOpacity(val); }

export function syncTo(timeUnix){
  // DWD WMS zeigt immer den aktuellsten Stand – kein Zeitsprung nötig.
  // Cache-Bust um sicherzustellen, dass das neueste Bild geladen wird.
  if(!layer) return;
  layer.setParams({ _t: Date.now() });
}
