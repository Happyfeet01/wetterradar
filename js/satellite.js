// Satellitenbilder via DWD WMS (ersetzt RainViewer IR, das seit 2025 eingestellt ist)
import { DWD_SAT_WMS, DWD_SAT_LAYER } from './config.js';

const DWD_SAT_WMS_FALLBACK = 'https://maps.dwd.de/geoserver/dwd/wms?';

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

export function toggle(L, map, on, opacity=0.7){
  if(on){
    if(layer) map.removeLayer(layer);
    usingFallbackHost = false;
    layer = createLayer(L, DWD_SAT_WMS, opacity).addTo(map);

    // Falls kein same-origin Proxy vorhanden ist (z.B. lokale Entwicklung),
    // wechsle automatisch auf den direkten DWD-Endpunkt.
    // In Produktion (HTTPS + nicht localhost) bleibt der Proxy aktiv, damit
    // Browser-Sicherheitsmechanismen (z.B. ORB/CSP) nicht durch Cross-Origin-
    // Requests unnötig Fehler produzieren.
    layer.once('tileerror', ()=>{
      if(!layer || usingFallbackHost) return;
      const host = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
      const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
      if(!isLocalhost) return;
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
