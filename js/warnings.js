// warnings.js
import { DWD_WMS, DWD_WMS_LAYER, DWD_WARN_JSON } from './config.js';

const WARNING_LEVEL_COLORS = {
  1: '#ffff00',
  2: '#ffa500',
  3: '#ff0000',
  4: '#800080'
};
let mapInstance = null;
let cachedWarnings = [];
let filterUsesBounds = true;
let ninaLayer = null;
let ninaWarnings = [];
let ninaFetchPromise = null;

export function bind(L, map, ui){
  mapInstance = map;

  // --- Pane für Warn-Layer (über Radar/Wolken) ---
  map.createPane('warnPane');
  map.getPane('warnPane').style.zIndex = 510;

  let wms = null;

  // --- UI-Handler ---
  if (ui.chkWarn){
    ui.chkWarn.onchange = ()=> toggleWms(ui.chkWarn.checked);
  }
  if (ui.chkWarnList){
    ui.chkWarnList.onchange = ()=>{
      const box = document.getElementById('warnList');
      box.style.display = ui.chkWarnList.checked ? 'block' : 'none';
      if (ui.chkWarnList.checked) refreshList();
    };
  }

  const chkWarnInView = document.getElementById('chkWarnInView');
  if (chkWarnInView){
    chkWarnInView.onchange = ()=> renderWarnings();
  }

  map.on('moveend', ()=>{
    renderWarnings();
  });

  // --- WMS Toggle ---
  function toggleWms(on){
    if(on){
      if(wms){ wms.addTo(map); } else {
        wms = L.tileLayer.wms(DWD_WMS, {
          pane:'warnPane',
          layers:DWD_WMS_LAYER,
          version:'1.3.0',
          crs:L.CRS.EPSG3857,
          format:'image/png',
          transparent:true,
          tiled:true,
          opacity:0.75,
          attribution:'Warnungen © DWD'
        }).addTo(map);
      }
      ensureNinaLayer();
    } else if (wms){
      map.removeLayer(wms);
      if (ninaLayer){
        map.removeLayer(ninaLayer);
      }
    }
  }

  async function ensureNinaLayer(){
    const warnings = await loadNinaWarnings().catch(() => []);
    ninaWarnings = warnings;
    if (ninaLayer){
      ninaLayer.addTo(map);
    }
  }

  // --- JSONP Loader für DWD WARNUNGEN (Firefox-sicher) ---
  function loadJsonp(src, timeoutMs = 8000){
    return new Promise((resolve, reject) => {
      let done = false, timer = null, tag = null;

      // DWD ruft warnWetter.loadWarnings({...}) auf
      window.warnWetter = {
        loadWarnings: (data) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          cleanup();
          resolve(data);
        }
      };

      function cleanup(){
        try { if (tag && tag.parentNode) tag.parentNode.removeChild(tag); } catch {}
        try { delete window.warnWetter; } catch {}
      }

      tag = document.createElement('script');
      tag.src = src + (src.includes('?') ? '&' : '?') + '_=' + Date.now(); // Cache-Buster
      tag.async = true;
      tag.onerror = () => { if (done) return; done = true; clearTimeout(timer); cleanup(); reject(new Error('JSONP load failed')); };
      document.head.appendChild(tag);

      timer = setTimeout(() => {
        if (done) return;
        done = true; cleanup();
        reject(new Error('JSONP timeout'));
      }, timeoutMs);
    });
  }

  async function fetchWarningsJson(){
    // Achtung: DWD liefert JSONP, nicht pures JSON
    const data = await loadJsonp(DWD_WARN_JSON);
    return data; // hat Felder: { time, warnings: { <id>: [warnObj, ...], ... }, ... }
  }

  // --- Banner nur aktualisieren (ohne Liste zu rendern) ---
  async function refreshBannerOnly(){
    try{
      const [js, nina]  = await Promise.all([fetchWarningsJson(), loadNinaWarnings().catch(() => [])]);
      const all = Object.values(js?.warnings || {}).flat().concat(nina);
      const banner = document.getElementById('noWarnBanner');
      if (banner) banner.style.display = all.length ? 'none' : 'block';
    }catch(e){
      const banner = document.getElementById('noWarnBanner');
      if (banner) banner.style.display = 'block';
      console.warn('DWD banner update failed:', e);
    }
  }

  // --- Liste + Banner rendern ---
  async function refreshList(){
    try{
      const [js, nina] = await Promise.all([fetchWarningsJson(), loadNinaWarnings().catch(() => [])]);
      const all  = Object.values(js?.warnings || {}).flat().concat(Array.isArray(nina) ? nina : []);

      const banner = document.getElementById('noWarnBanner');
      if (banner) banner.style.display = all.length ? 'none' : 'block';

      renderWarnings(all);
    }catch(e){
      console.warn('DWD warnings failed:', e);
      cachedWarnings = [];

      const banner = document.getElementById('noWarnBanner');
      if (banner) banner.style.display = 'block';

      const root = document.getElementById('warnItems');
      if (root){
        root.style.maxHeight = '300px';
        root.style.overflowY = 'auto';
        root.innerHTML = '<div class="hint">Warnungen konnten nicht geladen werden.</div>';
      }
    }
  }

  // --- regelmäßige Aktualisierung ---
  setInterval(()=>{ refreshBannerOnly(); if(document.getElementById('warnList')?.style.display==='block') refreshList(); }, 5*60*1000);

  // initial
  refreshBannerOnly();
  // Liste erst laden, wenn aktiv
  if (ui.chkWarnList?.checked) refreshList();
}

async function loadNinaWarnings(){
  if (ninaFetchPromise){
    return ninaFetchPromise;
  }

  ninaFetchPromise = (async ()=>{
    try{
      const res = await fetch('/warnings/nina.geojson', { cache:'no-cache' });
      if (!res.ok){
        throw new Error(`NINA GeoJSON ${res.status}`);
      }
      const data = await res.json();
      const features = Array.isArray(data?.features) ? data.features : [];
      const warnings = features.map(featureToWarning).filter(Boolean);
      ninaWarnings = warnings;

      if (ninaLayer){
        try { mapInstance?.removeLayer(ninaLayer); } catch {}
      }

      if (mapInstance){
        ninaLayer = buildNinaLayer(features);
        if (ninaLayer && document.getElementById('chkWarn')?.checked){
          ninaLayer.addTo(mapInstance);
        }
      }

      return warnings;
    }catch(err){
      console.warn('NINA warnings failed:', err);
      return [];
    }
  })();

  return ninaFetchPromise.finally(() => {
    ninaFetchPromise = null;
  });
}

function buildNinaLayer(features){
  if (!Array.isArray(features)) return null;
  return L.geoJSON(features, {
    pane:'warnPane',
    style: (feature)=>({
      color: '#555',
      weight: 1,
      fillOpacity: 0.35,
      fillColor: WARNING_LEVEL_COLORS[Number(feature?.properties?.severity) || 0] || '#b3b3b3'
    }),
    onEachFeature: (feature, layer)=>{
      const props = feature?.properties || {};
      const title = props.headline || props.event || 'Warnung';
      const desc = props.description || '';
      const time = formatTimeRange(props.onset || props.effective, props.expires);
      const content = `<div class="warn-popup"><strong>${title}</strong><br>${props.provider || 'NINA'}${props.regionName ? ' – ' + props.regionName : ''}<br>${time || ''}<br>${(desc || '').replace(/\n/g,'<br>')}</div>`;
      layer.on('click', ()=>{
        layer.bindPopup(content).openPopup();
      });
    }
  });
}

function featureToWarning(feature){
  if (!feature || typeof feature !== 'object') return null;
  const props = feature.properties || {};
  const center = geometryCenter(feature.geometry) || props.centroid;
  return {
    id: props.id,
    level: Number(props.severity) || 0,
    severity: Number(props.severity) || 0,
    headline: props.headline || props.event || 'Warnung',
    description: props.description || '',
    provider: props.provider || props.source,
    source: props.source || 'NINA',
    regionName: props.regionName || props.rs,
    event: props.event,
    category: props.category,
    start: props.onset || props.effective,
    end: props.expires,
    geometry: feature.geometry,
    lat: center?.lat ?? null,
    lon: center?.lon ?? null
  };
}

export function renderWarnings(warnings){
  if (Array.isArray(warnings)){
    cachedWarnings = warnings.filter(w => w && typeof w === 'object');
  }

  if (!mapInstance){
    return [];
  }

  const bounds = mapInstance.getBounds();
  const useBounds = isBoundsFilterActive();
  filterUsesBounds = useBounds;

  const source = Array.isArray(cachedWarnings) ? cachedWarnings : [];
  const filtered = useBounds
    ? source.filter(w => isWarningInsideBounds(w, bounds))
    : source.slice();

  filtered.sort((a, b) => Number(b?.level ?? 0) - Number(a?.level ?? 0));

  updateWarningList(filtered);
  return filtered;
}

export function createWarningCard(warning){
  const level = Number(warning?.level ?? warning?.severity ?? 0);
  const color = WARNING_LEVEL_COLORS[level] || '#b3b3b3';

  const card = document.createElement('div');
  card.className = 'warn-card';
  card.dataset.level = Number.isFinite(level) && level > 0 ? String(level) : '';
  card.style.borderLeft = `6px solid ${color}`;
  card.style.padding = '8px 12px';
  card.style.margin = '0 0 8px 0';

  const title = document.createElement('div');
  title.className = 'warn-card__headline';
  title.textContent = warning?.headline || warning?.event || 'Wetterwarnung';
  card.appendChild(title);

  const metaParts = [];
  if (Number.isFinite(level) && level > 0){
    metaParts.push(`Stufe ${level}`);
  }
  const provider = (warning?.provider || warning?.source || '').trim();
  if (provider){
    metaParts.push(provider);
  }
  const region = (warning?.regionName || warning?.area || warning?.region || '').trim();
  if (region){
    metaParts.push(region);
  }
  const timeframe = formatTimeRange(warning?.start, warning?.end);
  if (timeframe){
    metaParts.push(timeframe);
  }

  if (metaParts.length){
    const meta = document.createElement('div');
    meta.className = 'warn-card__meta hint';
    meta.textContent = metaParts.join(' • ');
    card.appendChild(meta);
  }

  const description = (warning?.description || warning?.text || '').trim();
  if (description){
    const desc = document.createElement('div');
    desc.className = 'warn-card__description';
    appendTextWithBreaks(desc, description);
    card.appendChild(desc);
  }

  return card;
}

export function updateWarningList(filtered){
  const root = document.getElementById('warnItems');
  if (!root) return;

  root.style.maxHeight = '300px';
  root.style.overflowY = 'auto';
  root.innerHTML = '';

  if (!Array.isArray(filtered) || filtered.length === 0){
    const empty = document.createElement('div');
    empty.className = 'warn-empty hint';
    empty.textContent = filterUsesBounds
      ? 'Keine Warnungen im aktuellen Kartenausschnitt'
      : 'Derzeit keine aktiven Warnungen';
    root.appendChild(empty);
    return;
  }

  root.scrollTop = 0;
  filtered.forEach(w => {
    root.appendChild(createWarningCard(w));
  });
}

function appendTextWithBreaks(target, text){
  const parts = text.split(/\n+/).filter(part => part.trim().length > 0);
  if (!parts.length){
    target.textContent = text;
    return;
  }

  parts.forEach((part, idx) => {
    target.appendChild(document.createTextNode(part.trim()));
    if (idx < parts.length - 1){
      target.appendChild(document.createElement('br'));
    }
  });
}

function formatTimeRange(start, end){
  const startStr = formatTimestamp(start);
  const endStr = formatTimestamp(end);

  if (startStr && endStr){
    return `${startStr} – ${endStr}`;
  }
  return startStr || endStr || '';
}

function formatTimestamp(value){
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function isWarningInsideBounds(warning, bounds){
  const coords = extractCoordinates(warning);
  if (!coords) return false;

  const { lat, lon } = coords;
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();

  if (east < west){
    const withinLon = lon >= west || lon <= east;
    return withinLon && lat >= south && lat <= north;
  }

  return lat >= south && lat <= north && lon >= west && lon <= east;
}

function extractCoordinates(warning){
  if (!warning || typeof warning !== 'object') return null;

  const centroid = geometryCenter(warning.geometry || warning);
  if (centroid) return centroid;

  const lat = pickNumeric([
    warning.lat,
    warning.latitude,
    warning?.latLng?.lat,
    warning?.latlng?.lat,
    warning?.position?.lat,
    warning?.coordinates?.[1],
    warning?.coord?.[1],
    warning?.geometry?.coordinates?.[1],
    warning?.geometry?.coordinates?.[0]?.[1],
    Array.isArray(warning?.geometry?.coordinates?.[0]) && Array.isArray(warning?.geometry?.coordinates?.[0][0])
      ? warning.geometry.coordinates[0][0][1]
      : undefined,
    Array.isArray(warning?.geometry?.geometries)
      ? warning.geometry.geometries[0]?.coordinates?.[1]
      : undefined
  ]);

  const lon = pickNumeric([
    warning.lon,
    warning.lng,
    warning.longitude,
    warning?.latLng?.lng,
    warning?.latlng?.lng,
    warning?.position?.lng,
    warning?.position?.lon,
    warning?.coordinates?.[0],
    warning?.coord?.[0],
    warning?.geometry?.coordinates?.[0],
    warning?.geometry?.coordinates?.[0]?.[0],
    Array.isArray(warning?.geometry?.coordinates?.[0]) && Array.isArray(warning?.geometry?.coordinates?.[0][0])
      ? warning.geometry.coordinates[0][0][0]
      : undefined,
    Array.isArray(warning?.geometry?.geometries)
      ? warning.geometry.geometries[0]?.coordinates?.[0]
      : undefined
  ]);

  if (lat === null || lon === null) return null;
  return { lat, lon };
}

function pickNumeric(candidates){
  for (const value of candidates){
    const numeric = parseCoordinate(value);
    if (numeric !== null) return numeric;
  }
  return null;
}

function parseCoordinate(value){
  if (value === undefined || value === null) return null;
  if (typeof value === 'string'){
    const normalized = value.trim().replace(',', '.');
    if (!normalized){
      return null;
    }
    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function geometryCenter(geometry){
  if (!geometry || typeof geometry !== 'object') return null;
  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)){
    const [lon, lat] = geometry.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }

  const coords = geometry.type === 'Polygon'
    ? geometry.coordinates?.[0]
    : geometry.type === 'MultiPolygon'
      ? geometry.coordinates?.[0]?.[0]
      : null;

  if (Array.isArray(coords) && coords.length){
    let sumLat = 0;
    let sumLon = 0;
    let count = 0;
    coords.forEach(pair => {
      if (Array.isArray(pair) && pair.length >= 2){
        const [lon, lat] = pair;
        if (Number.isFinite(lat) && Number.isFinite(lon)){
          sumLat += lat;
          sumLon += lon;
          count += 1;
        }
      }
    });
    if (count){
      return { lat: sumLat / count, lon: sumLon / count };
    }
  }
  return null;
}

function isBoundsFilterActive(){
  const chk = document.getElementById('chkWarnInView');
  return !chk || chk.checked;
}
