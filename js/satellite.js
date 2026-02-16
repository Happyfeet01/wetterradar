// Satellitenbilder via DWD WMS (ersetzt RainViewer IR, das seit 2025 eingestellt ist)
import { DWD_SAT_WMS, DWD_SAT_LAYER } from './config.js';

let layer = null;

export async function loadSatellite(){
  // DWD WMS benötigt kein Vorab-Laden von Frames –
  // der Layer zeigt immer den aktuellsten Stand.
  return [];
}

export function toggle(L, map, on, opacity=0.7){
  if(on){
    if(layer) map.removeLayer(layer);
    layer = L.tileLayer.wms(DWD_SAT_WMS, {
      layers: DWD_SAT_LAYER,
      format: 'image/png',
      transparent: true,
      pane: 'cloudPane',
      opacity,
      attribution: 'Satellit © DWD'
    }).addTo(map);
  }else if(layer){
    map.removeLayer(layer); layer=null;
  }
}

export function setOpacity(val){ if(layer) layer.setOpacity(val); }

export function syncTo(timeUnix){
  // DWD WMS zeigt immer den aktuellsten Stand – kein Zeitsprung nötig.
  // Cache-Bust um sicherzustellen, dass das neueste Bild geladen wird.
  if(!layer) return;
  layer.setParams({ _t: Date.now() });
}