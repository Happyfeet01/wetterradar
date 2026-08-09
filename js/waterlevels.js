const PEGELONLINE_BASE = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2';
const REFRESH_MS = 6 * 60 * 60 * 1000;

let layer = null;
let refreshTimer = null;
let lastLoaded = 0;

function statusMeta(state){
  const s = String(state || '').toLowerCase();
  if(s === 'low') return { label:'zu niedrig', color:'#1976d2' };
  if(s === 'high') return { label:'zu hoch', color:'#d32f2f' };
  if(s === 'normal') return { label:'normal', color:'#2e7d32' };
  if(s === 'outdated') return { label:'veraltet', color:'#757575' };
  if(s === 'unknown') return { label:'unbekannt', color:'#757575' };
  return { label:s || 'unbekannt', color:'#757575' };
}

function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}

async function fetchStations(){
  const url = `${PEGELONLINE_BASE}/stations.json?includeTimeseries=true&includeCurrentMeasurement=true`;
  const res = await fetch(url, { cache:'no-store' });
  if(!res.ok) throw new Error(`PEGELONLINE HTTP ${res.status}`);
  return res.json();
}

function getWaterLevel(station){
  const series = Array.isArray(station?.timeseries) ? station.timeseries : [];
  return series.find(item => item?.shortname === 'W' || item?.unit === 'cm') || null;
}

function stationLatLng(station){
  const lat = Number(station?.latitude);
  const lon = Number(station?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}

function markerFor(L, station){
  const latlng = stationLatLng(station);
  const series = getWaterLevel(station);
  const measurement = series?.currentMeasurement;
  const value = Number(measurement?.value);
  if(!latlng || !Number.isFinite(value)) return null;

  const status = statusMeta(measurement?.stateMnwMhw);
  const icon = L.divIcon({
    className:'pegel-marker',
    html:`<div class="pegel-marker__inner" style="--pegel-color:${status.color}">${Math.round(value)}<span>cm</span></div>`,
    iconSize:[48,34], iconAnchor:[24,17], popupAnchor:[0,-18]
  });

  const marker = L.marker(latlng, { icon });
  const time = measurement?.timestamp ? new Date(measurement.timestamp).toLocaleString('de-DE') : '–';
  marker.bindPopup(`
    <div class="pegel-popup">
      <strong>${escapeHtml(station?.longname || station?.shortname || 'Pegel')}</strong><br>
      Gewässer: ${escapeHtml(station?.water?.longname || station?.water?.shortname || '–')}<br>
      Pegel: <strong>${Math.round(value)} cm</strong><br>
      Status: <strong style="color:${status.color}">${status.label}</strong><br>
      <small>Stand: ${escapeHtml(time)}</small>
    </div>
  `);
  marker.bindTooltip(`${escapeHtml(station?.shortname || station?.longname || 'Pegel')}: ${Math.round(value)} cm · ${status.label}`);
  return marker;
}

async function load(L, map, ui, force=false){
  if(!layer) layer = L.layerGroup();
  if(!force && lastLoaded && Date.now() - lastLoaded < REFRESH_MS) return;

  if(ui?.lblWaterLevelsInfo) ui.lblWaterLevelsInfo.textContent = 'Pegel werden geladen…';
  try{
    const stations = await fetchStations();
    layer.clearLayers();
    let count = 0;
    for(const station of stations){
      const marker = markerFor(L, station);
      if(marker){ marker.addTo(layer); count++; }
    }
    lastLoaded = Date.now();
    if(ui?.lblWaterLevelsInfo) ui.lblWaterLevelsInfo.textContent = `${count} Pegel · Stand ${new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}`;
  }catch(err){
    console.warn('PEGELONLINE konnte nicht geladen werden:', err);
    if(ui?.lblWaterLevelsInfo) ui.lblWaterLevelsInfo.textContent = 'Pegeldaten nicht verfügbar';
  }
}

export function bindWaterLevels(L, map, ui){
  if(!ui?.chkWaterLevels) return;
  layer = L.layerGroup();

  const sync = async force => {
    if(ui.chkWaterLevels.checked){
      await load(L, map, ui, force);
      if(!map.hasLayer(layer)) layer.addTo(map);
    }else if(map.hasLayer(layer)){
      map.removeLayer(layer);
    }
  };

  ui.chkWaterLevels.onchange = () => sync(false);
  refreshTimer = setInterval(() => {
    if(ui.chkWaterLevels.checked) sync(true);
  }, REFRESH_MS);
}
