// Satellitenbilder via DWD WMS (ersetzt RainViewer IR, das seit 2025 eingestellt ist)
import { DWD_SAT_WMS, DWD_SAT_LAYER, DWD_SAT_LAYERS } from './config.js';

let layer = null;
let activeLayerName = DWD_SAT_LAYER;
let fallbackIndex = 0;

export async function loadSatellite(){
  // DWD WMS benötigt kein Vorab-Laden von Frames –
  // der Layer zeigt immer den aktuellsten Stand.
  return [];
}

export function toggle(L, map, on, opacity=0.7){
  if(on){
    if(layer) map.removeLayer(layer);
    fallbackIndex = Math.max(DWD_SAT_LAYERS.indexOf(activeLayerName), 0);
    layer = createLayer(L, map, opacity, fallbackIndex);
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

function createLayer(L, map, opacity, layerIndex){
  const layerName = DWD_SAT_LAYERS[layerIndex] || DWD_SAT_LAYER;
  const wmsLayer = L.tileLayer.wms(DWD_SAT_WMS, {
    layers: layerName,
    format: 'image/png',
    transparent: true,
    pane: 'cloudPane',
    opacity,
    attribution: 'Satellit © DWD'
  });

  wmsLayer.on('tileerror', () => {
    const nextIndex = layerIndex + 1;
    if(nextIndex >= DWD_SAT_LAYERS.length) return;

    if(layer === wmsLayer){
      map.removeLayer(wmsLayer);
      fallbackIndex = nextIndex;
      activeLayerName = DWD_SAT_LAYERS[nextIndex];
      layer = createLayer(L, map, wmsLayer.options.opacity ?? opacity, nextIndex);
      console.warn(`DWD Satellitenlayer fehlgeschlagen (${layerName}), Fallback auf ${activeLayerName}.`);
    }
  });

  activeLayerName = layerName;
  return wmsLayer.addTo(map);
}
