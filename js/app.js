import { OSM_URL, PLAY_FADE_MS } from './config.js';
import * as Radar from './radar.js';
import * as Sat from './satellite.js';
import { bind as bindWarnings } from './warnings.js';
import { bindWindFlow } from './windflow.js';

const map = L.map('map', { zoomSnap:0.5, worldCopyJump:true, maxZoom:10 }).setView([51.2,10.5], 6);
L.tileLayer(OSM_URL, { maxZoom:19, attribution:'© OpenStreetMap-Mitwirkende' }).addTo(map);

// Panes
map.createPane('radarPane');  map.getPane('radarPane').style.zIndex = 450;
map.createPane('cloudPane');  map.getPane('cloudPane').style.zIndex = 500;

// UI
const $ = id => document.getElementById(id);
const ui = {
  btnPrev: $('btnPrev'), btnNext:$('btnNext'), btnPlay:$('btnPlay'),
  lblTime:$('lblTime'), btnLocate:$('btnLocate'), lblLocationWind:$('lblLocationWind'),
  selColor:$('selColor'), chkSmooth:$('chkSmooth'), rngSpeed:$('rngSpeed'),
  rngOpacity:$('rngOpacity'), lblOpacity:$('lblOpacity'),
  chkClouds:$('chkClouds'), rngClouds:$('rngClouds'), lblClouds:$('lblClouds'),
  chkWarn:$('chkWarn'), chkWarnList:$('chkWarnList'),
  chkDark:$('chkDark'),
  chkWindFlow:$('chkWindFlow'),
  controlPanel:$('controlPanel'),
  btnPanelToggle:$('btnPanelToggle'),
};

// Modules
bindWarnings(L, map, ui);
bindWindFlow(L, map, ui);

if(ui.btnPanelToggle && ui.controlPanel){
  ui.btnPanelToggle.onclick = ()=>{
    const collapsed = ui.controlPanel.classList.toggle('collapsed');
    ui.btnPanelToggle.setAttribute('aria-expanded', String(!collapsed));
    ui.btnPanelToggle.textContent = collapsed ? '▸' : '▾';
    ui.btnPanelToggle.setAttribute('aria-label', collapsed ? 'Bedienpanel ausklappen' : 'Bedienpanel einklappen');
  };
}

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
  };
  ui.selColor.onchange = ()=> Radar.paint(L,map,ui,syncClouds);
  ui.chkSmooth.onchange = ()=> Radar.paint(L,map,ui,syncClouds);

  ui.chkClouds.onchange = ()=> Sat.toggle(L, map, ui.chkClouds.checked, Number(ui.rngClouds.value));
  ui.rngClouds.oninput = ()=>{ ui.lblClouds.textContent=Math.round(Number(ui.rngClouds.value)*100)+'%'; Sat.setOpacity(Number(ui.rngClouds.value)); };

  ui.chkDark.onchange = ()=> document.body.classList.toggle('dark', ui.chkDark.checked);

  const locationTooltipOptions = { permanent:true, direction:'top', offset:[0,-22], className:'wind-tooltip' };
  let locateMarker=null, locateCircle=null;

  function setWindBadge(text, visible=true){
    if(!ui.lblLocationWind) return;
    if(!visible){
      if(text) ui.lblLocationWind.textContent = text;
      ui.lblLocationWind.style.display = 'none';
      return;
    }
    if(!text){
      ui.lblLocationWind.textContent = '';
      ui.lblLocationWind.style.display = 'none';
      return;
    }
    ui.lblLocationWind.textContent = text;
    ui.lblLocationWind.style.display = 'inline-block';
  }
  const showWindLoading = ()=> setWindBadge('Wind wird geladen…');
  const showWindError = (msg='Winddaten nicht verfügbar')=> setWindBadge(msg);
  const showWindInfo = info => {
    if(!info) return setWindBadge('Winddaten nicht verfügbar');
    const dirText = Number.isFinite(info.direction) ? `${Math.round(info.direction)}°` : '–';
    const speedText = Number.isFinite(info.speedKmh) ? info.speedKmh.toFixed(1) : '–';
    setWindBadge(`Wind: ${speedText} km/h (${dirText})`);
  };

  function updateAccuracyCircle(lat, lon, accuracy){
    const safeRadius = Math.max(Number(accuracy) || 0, 30);
    const style = { color:'#1976d2', weight:2, fillColor:'#64b5f6', fillOpacity:0.18 };
    if(locateCircle){
      locateCircle.setLatLng([lat, lon]);
      locateCircle.setRadius(safeRadius);
      locateCircle.setStyle(style);
    }else{
      locateCircle = L.circle([lat, lon], { ...style, radius: safeRadius }).addTo(map);
    }
  }

  function updateLocationMarker(lat, lon, direction){
    const rot = Number.isFinite(direction) ? direction : 0;
    const pointerStyle = Number.isFinite(direction) ? `--rot:${rot}deg;` : '--rot:0deg;opacity:0;';
    const icon = L.divIcon({
      className:'loc-icon',
      html:`<div class="loc-marker"><div class="loc-pointer" style="${pointerStyle}"></div></div>`,
      iconSize:[36,36], iconAnchor:[18,18], tooltipAnchor:[0,-20],
    });
    if(locateMarker){
      locateMarker.setLatLng([lat, lon]);
      locateMarker.setIcon(icon);
    }else{
      locateMarker = L.marker([lat, lon], {icon}).addTo(map);
    }
    return locateMarker;
  }

  async function fetchWindInfo(lat, lon){
    const params = new URLSearchParams({
      latitude: lat.toFixed(3),
      longitude: lon.toFixed(3),
      current_weather: 'true',
      windspeed_unit: 'ms',
      timezone: 'auto',
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, { cache:'no-store' });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const cw = data?.current_weather;
    if(!cw) throw new Error('Keine aktuellen Winddaten');
    const speedMsRaw = Number(cw.windspeed);
    const directionRaw = Number(cw.winddirection ?? cw.wind_direction);
    const speedMs = Number.isFinite(speedMsRaw) ? speedMsRaw : null;
    return {
      speedMs,
      speedKmh: speedMs == null ? null : speedMs * 3.6,
      direction: Number.isFinite(directionRaw) ? directionRaw : null,
    };
  }

  function updateWindTooltip(marker, info){
    if(!marker) return;
    if(!info){
      if(marker.getTooltip()) marker.setTooltipContent('Winddaten nicht verfügbar');
      else marker.bindTooltip('Winddaten nicht verfügbar', locationTooltipOptions);
      return;
    }
    const dirText = Number.isFinite(info.direction) ? `${Math.round(info.direction)}°` : '–';
    const speedKmhText = Number.isFinite(info.speedKmh) ? info.speedKmh.toFixed(1) : '–';
    const speedMsText = Number.isFinite(info.speedMs) ? info.speedMs.toFixed(1) : '–';
    const content = `Wind: ${speedKmhText} km/h (${speedMsText} m/s)<br>Richtung: ${dirText}`;
    if(marker.getTooltip()) marker.setTooltipContent(content);
    else marker.bindTooltip(content, locationTooltipOptions);
  }

  ui.btnLocate.onclick = ()=>{
    if(!navigator.geolocation){
      showWindError('Standortbestimmung nicht unterstützt');
      alert('Geolokalisierung wird von diesem Browser nicht unterstützt.');
      return;
    }
    ui.btnLocate.disabled = true;
    showWindLoading();
    navigator.geolocation.getCurrentPosition(async pos=>{
      const { latitude, longitude, accuracy } = pos.coords;
      const zoom= accuracy<=50?14:accuracy<=150?12:accuracy<=1000?10:9;
      map.setView([latitude,longitude], Math.min(zoom, map.getMaxZoom()));
      updateAccuracyCircle(latitude, longitude, accuracy);
      const marker = updateLocationMarker(latitude, longitude, null);
      try{
        const wind = await fetchWindInfo(latitude, longitude);
        updateLocationMarker(latitude, longitude, wind.direction ?? null);
        updateWindTooltip(marker, wind);
        showWindInfo(wind);
      }catch(err){
        console.warn('Winddaten konnten nicht geladen werden:', err);
        updateWindTooltip(marker, null);
        showWindError();
      }finally{
        ui.btnLocate.disabled = false;
      }
    }, err=>{
      console.warn('Geolokalisierung fehlgeschlagen:', err);
      ui.btnLocate.disabled = false;
      showWindError('Standort nicht verfügbar');
    }, { enableHighAccuracy:true, maximumAge:120000, timeout:15000 });
  };

  // Marker für aktuelle Zeit
  Radar.paint(L, map, ui, syncClouds);
  const marker = document.getElementById('currentTimeMarker');
  if (marker) {
    const now = Date.now() / 1000;
    const frames = Radar.getFrames();
    const currentFrame = frames[Radar.getIndex()];
    if (currentFrame && Math.abs(currentFrame.time - now) < 60) {
      marker.style.display = 'block';
    }
  }

  // regelmäßige Aktualisierung
  setInterval(async ()=>{
    await Promise.all([Radar.loadRadar(), Sat.loadSatellite()]);
    const frames = Radar.getFrames();
    const current = frames[Radar.getIndex()];
    if(current) syncClouds(current.time);
    Radar.paint(L,map,ui,syncClouds);
    // Aktualisiere Marker
    const now = Date.now() / 1000;
    if (marker && frames[Radar.getIndex()] && Math.abs(frames[Radar.getIndex()].time - now) < 60) {
      marker.style.display = 'block';
    } else if (marker) {
      marker.style.display = 'none';
    }
  }, 5*60*1000);

  // Optional: Wind standardmäßig aktivieren
  // ui.chkWindFlow.checked = true;
  // ui.chkWindFlow.onchange();
}

boot();