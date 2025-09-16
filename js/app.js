import { OSM_URL, PLAY_FADE_MS } from './config.js';
import * as Radar from './radar.js';
import * as Sat from './satellite.js';
import { bind as bindLightning } from './lightning.js';
import { bind as bindWarnings } from './warnings.js';

const map = L.map('map', { zoomSnap:0.5, worldCopyJump:true, maxZoom:10 }).setView([51.2,10.5], 6);
L.tileLayer(OSM_URL, { maxZoom:19, attribution:'© OpenStreetMap-Mitwirkende' }).addTo(map);

// Panes
map.createPane('radarPane');  map.getPane('radarPane').style.zIndex = 450;
map.createPane('cloudPane');  map.getPane('cloudPane').style.zIndex = 500;

// UI
const $ = id => document.getElementById(id);
const ui = {
  btnPrev: $('btnPrev'), btnNext:$('btnNext'), btnPlay:$('btnPlay'),
  lblTime:$('lblTime'), btnLocate:$('btnLocate'), lblCity:$('lblCity'),
  selColor:$('selColor'), chkSmooth:$('chkSmooth'), rngSpeed:$('rngSpeed'),
  rngOpacity:$('rngOpacity'), lblOpacity:$('lblOpacity'),
  chkClouds:$('chkClouds'), rngClouds:$('rngClouds'), lblClouds:$('lblClouds'),
  chkLightning:$('chkLightning'),
  chkWarn:$('chkWarn'), chkWarnList:$('chkWarnList'),
  chkDark:$('chkDark'),
};

// Modules
bindLightning(L, map, ui);
bindWarnings(L, map, ui);

function syncClouds(timeUnix){ Sat.syncTo(timeUnix); }

async function boot(){
  await Radar.loadRadar();
  await Sat.loadSatellite();
  Radar.paint(L, map, ui, syncClouds);

  // Controls
  let playing=false, timer=null;
  const stepMs = ()=> Math.max(Number(ui.rngSpeed.value), PLAY_FADE_MS+80);

  ui.btnPrev.onclick = ()=>{ Radar.step(-1); Radar.paint(L, map, ui, syncClouds); };
  ui.btnNext.onclick = ()=>{ Radar.step(+1); Radar.paint(L, map, ui, syncClouds); };
  ui.btnPlay.onclick = ()=>{
    playing=!playing; ui.btnPlay.textContent = playing?'⏸':'▶︎';
    if(playing){ timer=setInterval(()=>{ Radar.step(+1); Radar.paint(L,map,ui,syncClouds); }, stepMs()); }
    else clearInterval(timer);
  };
  ui.rngSpeed.oninput = ()=>{ if(playing){ clearInterval(timer); timer=setInterval(()=>{ Radar.step(+1); Radar.paint(L,map,ui,syncClouds); }, stepMs()); }};

  ui.rngOpacity.oninput = ()=>{
    ui.lblOpacity.textContent = Math.round(Number(ui.rngOpacity.value)*100)+'%';
    // neue Opacity greift beim nächsten Frame, optional könntest du das aktuelle Layer merken und setzen
  };
  ui.selColor.onchange = ()=> Radar.paint(L,map,ui,syncClouds);
  ui.chkSmooth.onchange = ()=> Radar.paint(L,map,ui,syncClouds);

  ui.chkClouds.onchange = ()=> Sat.toggle(L, map, ui.chkClouds.checked, Number(ui.rngClouds.value));
  ui.rngClouds.oninput = ()=>{ ui.lblClouds.textContent=Math.round(Number(ui.rngClouds.value)*100)+'%'; Sat.setOpacity(Number(ui.rngClouds.value)); };

  ui.chkDark.onchange = ()=> document.body.classList.toggle('dark', ui.chkDark.checked);

  ui.btnLocate.onclick = ()=> navigator.geolocation?.getCurrentPosition(pos=>{
    const {latitude, longitude, accuracy}=pos.coords;
    const zoom= accuracy<=50?14:accuracy<=150?12:accuracy<=1000?10:9;
    map.setView([latitude,longitude], Math.min(zoom, map.getMaxZoom()));
    L.circle([latitude,longitude], {radius:accuracy, weight:1}).addTo(map);
  });

  // regelmäßige Aktualisierung
  setInterval(async ()=>{ await Radar.loadRadar(); Radar.paint(L,map,ui,syncClouds); }, 5*60*1000);
}

boot();
