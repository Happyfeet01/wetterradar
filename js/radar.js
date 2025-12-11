import { RV_API, RV_HOST_FALLBACK, RADAR_SIZE, RADAR_ZOOM_OFFSET, PLAY_FADE_MS } from './config.js';

let RV_HOST = RV_HOST_FALLBACK;
let frames = [];
let idx = 0;
let curr=null, next=null;

export async function loadRadar(){
  const data = await fetch(RV_API, { cache:'no-store' }).then(r=>r.json());
  RV_HOST = data.host || RV_HOST_FALLBACK;
  frames = [...(data?.radar?.past ?? []), ...(data?.radar?.nowcast ?? [])];

  // Setze den Index auf den letzten Zeitpunkt, der nicht in der Zukunft liegt
  const now = Date.now() / 1000;
  idx = frames.reduce((closest, frame, i) =>
    (Math.abs(frame.time - now) < Math.abs(frames[closest].time - now) && frame.time <= now) ? i : closest, 0);
  return frames;
}

export function getFrames(){ return frames; }
export function getIndex(){ return idx; }
export function step(d){ if(!frames.length) return; idx = (idx + d + frames.length) % frames.length; }

function radarUrl(frame, ui){
  const color = Number(ui.selColor.value) || 4;
  const smooth = ui.chkSmooth.checked ? 1 : 0;
  const snow = 0;
  const host=(RV_HOST||RV_HOST_FALLBACK).replace(/\/+$/,'');
  let path=String(frame.path||'').replace(/^\/+/, '');
  if (!path.startsWith('v2/')) path = 'v2/radar/' + path;
  return `${host}/${path}/${RADAR_SIZE}/{z}/{x}/{y}/${color}/${smooth}_${snow}.png?${frame.time}`;
}

export function paint(L, map, ui, syncCloudsCb){
  const f = frames[idx]; if(!f) return;
  if(next){ map.removeLayer(next); next=null; }
  next = L.tileLayer(radarUrl(f, ui), {
    pane:'radarPane', tileSize:RADAR_SIZE, zoomOffset:RADAR_ZOOM_OFFSET,
    opacity:0, className:'rv-tiles',
    updateWhenZooming:false, updateWhenIdle:true, keepBuffer:4, attribution:'Radar © RainViewer'
  }).addTo(map);

  const dt=new Date(f.time*1000);
  ui.lblTime.textContent = dt.toLocaleString([], {dateStyle:'short', timeStyle:'short'});

  const op = Number(ui.rngOpacity.value);
  ui.lblOpacity.textContent = Math.round(op*100) + '%';

  requestAnimationFrame(()=>{
    if(!next) return;
    next.setOpacity(op);
    if(!curr){ curr=next; next=null; return; }
    curr.setOpacity(0);
    setTimeout(()=>{ map.removeLayer(curr); curr=next; next=null; }, PLAY_FADE_MS + 40);
  });

  if (syncCloudsCb) syncCloudsCb(f.time);
}