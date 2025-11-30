import { RV_API, RV_HOST_FALLBACK, RADAR_SIZE } from './config.js';

let RV_HOST = RV_HOST_FALLBACK;
let satFrames = [];
let layer = null;

export async function loadSatellite(){
  const data = await fetch(RV_API, { cache:'no-store' }).then(r=>r.json());
  RV_HOST = data.host || RV_HOST_FALLBACK;
  satFrames = [...(data?.satellite?.infrared ?? [])];
  return satFrames;
}

function satUrl(frame){
  const host=(RV_HOST||RV_HOST_FALLBACK).replace(/\/+$/,'');
  let path=String(frame.path||'').replace(/^\/+/, '');
  if (!path.startsWith('v2/')) path = 'v2/satellite/' + path;
  return `${host}/${path}/${RADAR_SIZE}/{z}/{x}/{y}/0/0_0.png?${frame.time}`;
}

export function toggle(L, map, on, opacity=0.7){
  if(on){
    const f = satFrames[satFrames.length-1];
    if(!f){ alert('Noch keine Satellitenframes.'); return; }
    if(layer) map.removeLayer(layer);
    layer = L.tileLayer(satUrl(f), {
      pane:'cloudPane',
      tileSize:RADAR_SIZE,
      opacity,
      // Ohne noWrap springt die Weltkopie-Logik und der Sat-Film "dreht" sich sichtbar
      noWrap:true,
      bounds:L.latLngBounds([-85, -180], [85, 180]),
    }).addTo(map);
  }else if(layer){
    map.removeLayer(layer); layer=null;
  }
}

export function setOpacity(val){ if(layer) layer.setOpacity(val); }

export function syncTo(timeUnix){
  if(!layer || !satFrames.length) return;
  let best=satFrames[0], dBest=Math.abs(timeUnix-best.time);
  for(const s of satFrames){ const d=Math.abs(timeUnix-s.time); if(d<dBest){dBest=d; best=s;} }
  layer.setUrl(satUrl(best));
}
