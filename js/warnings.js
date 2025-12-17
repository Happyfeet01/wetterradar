// warnings.js
// Aktualisierte Warnlogik: DWD-Polygone + BBK/NINA mit Sidebar und Tab-Navigation.
import { DWD_WFS } from './config.js';

const WARNING_LEVEL_COLORS = {
  1: '#ffff00',
  2: '#ffa500',
  3: '#ff0000',
  4: '#800080'
};

const NINA_SIDEBAR_LIMIT = 30;
const NINA_DETAIL_LIMIT = 20;

function parseEcAreaColor(s){
  if (typeof s !== 'string') return null;
  const parts = s.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(v => !Number.isFinite(v))) return null;
  const [r, g, b] = parts.map(v => Math.max(0, Math.min(255, Math.round(v))));
  return `rgb(${r},${g},${b})`;
}

function severityToColor(levelOrSeverity){
  const normalized = String(levelOrSeverity ?? '').toLowerCase();
  const numeric = Number(normalized);
  const level = Number.isFinite(numeric) ? numeric : normalized;
  switch(level){
    case 1:
    case '1':
    case 'minor':
      return 'rgb(255,235,59)';
    case 2:
    case '2':
    case 'moderate':
      return 'rgb(255,152,0)';
    case 3:
    case '3':
    case 'severe':
      return 'rgb(244,67,54)';
    case 4:
    case '4':
    case 'extreme':
      return 'rgb(156,39,176)';
    default:
      return 'rgb(160,160,160)';
  }
}

function deriveDwdColor(props){
  if (!props) return severityToColor();
  const direct = parseEcAreaColor(props.EC_AREA_COLOR);
  if (direct) return direct;
  const candidates = [props.SEVERITY, props.EVENT_LEVEL, props.WARNING_LEVEL, props.LEVEL, props.WARNINGLEVEL];
  for (const sev of candidates){
    if (sev !== null && sev !== undefined){
      return severityToColor(sev);
    }
  }
  return severityToColor();
}

function pickStrokeColor(bg){
  if (typeof bg !== 'string') return 'rgba(0,0,0,0.35)';
  const match = bg.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (!match) return 'rgba(0,0,0,0.35)';
  const [r, g, b] = match.slice(1).map(Number).map(v => Math.max(0, Math.min(255, Math.round(v * 0.72))));
  return `rgba(${r},${g},${b},0.9)`;
}

function pickTextColor(bgRgbString){
  if (typeof bgRgbString !== 'string') return '#000';
  const match = bgRgbString.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (!match) return '#000';
  const [, rStr, gStr, bStr] = match;
  const r = Number(rStr);
  const g = Number(gStr);
  const b = Number(bStr);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#000' : '#fff';
}

function fallbackColorBySeverity(sev){
  if (sev === null || sev === undefined) return null;
  const numeric = Number(sev);
  if (Number.isFinite(numeric)){
    switch(numeric){
      case 1:
        return 'rgb(255,235,59)';
      case 2:
        return 'rgb(255,152,0)';
      case 3:
        return 'rgb(244,67,54)';
      case 4:
        return 'rgb(156,39,176)';
      default:
        return null;
    }
  }
  const normalized = String(sev || '').toLowerCase();
  switch(normalized){
    case '1':
    case 'minor':
      return 'rgb(255,235,59)';
    case '2':
    case 'moderate':
      return 'rgb(255,152,0)';
    case '3':
    case 'severe':
      return 'rgb(244,67,54)';
    case '4':
    case 'extreme':
      return 'rgb(156,39,176)';
    default:
      return null;
  }
}

let mapRef = null;
let leafletRef = null;
let dwdLayer = null;
let ninaLayer = null;
let allDwdFeatures = [];
let ninaFeatures = [];
let ninaListItems = [];
let sidebarTimer = null;
let ninaLoadPromise = null;

const ninaDetailsCache = new Map();
const ninaGeometryCache = new Map();

// DOM-Referenzen
const dom = {
  listBox: null,
  tabs: null,
  panelDwd: null,
  panelNina: null,
  listDwd: null,
  listNina: null,
  chkWarnList: null,
  chkDwd: null,
  chkNina: null
};

export function bind(L, map, ui){
  leafletRef = L;
  mapRef = map;

  // Pane für Warnlayer oberhalb der Wolken
  map.createPane('warnPane');
  map.getPane('warnPane').style.zIndex = 510;

  // Sammle DOM-Elemente einmalig
  dom.listBox = document.getElementById('warnList');
  dom.tabs = {
    dwd: document.getElementById('tabDwd'),
    nina: document.getElementById('tabNina')
  };
  dom.panelDwd = document.getElementById('panelDwd');
  dom.panelNina = document.getElementById('panelNina');
  dom.listDwd = document.getElementById('warnItemsDwd');
  dom.listNina = document.getElementById('warnItemsNina');
  dom.chkWarnList = ui.chkWarnList;
  dom.chkDwd = ui.chkWarn;
  dom.chkNina = document.getElementById('chkNina');

  // Checkboxen + Tabs binden (persistente Auswahl)
  bindCheckbox(dom.chkDwd, 'chkWarn', toggleDwdLayer);
  bindCheckbox(dom.chkNina, 'chkNina', toggleNinaLayer);
  bindCheckbox(dom.chkWarnList, 'chkWarnList', setSidebarVisibility);
  bindTabs();

  // Bewegungen des Kartenfensters leicht entprellt auswerten
  const debouncedSidebar = debounce(refreshSidebar, 140);
  map.on('moveend zoomend', debouncedSidebar);

  // Initiale Daten laden + Layer ggf. direkt einschalten
  loadDwdWarnings();
  if (dom.chkDwd?.checked) toggleDwdLayer(true);
  ninaLoadPromise = loadNinaWarnings();
  if (dom.chkNina?.checked) toggleNinaLayer(true);
}

function escapeAttributeValue(value){
  return String(value ?? '').replace(/"/g, '\\"');
}

function bindCheckbox(el, storageKey, onChange){
  if (!el) return;
  const stored = localStorage.getItem(storageKey);
  if (stored !== null){
    el.checked = stored === '1';
  }
  el.onchange = ()=>{
    localStorage.setItem(storageKey, el.checked ? '1' : '0');
    if (typeof onChange === 'function') onChange(el.checked);
  };
}

function debounce(fn, wait = 120){
  return (...args) => {
    if (sidebarTimer) clearTimeout(sidebarTimer);
    sidebarTimer = setTimeout(() => fn(...args), wait);
  };
}

async function fetchJsonStrict(url){
  try{
    const res = await fetch(url, { cache:'no-store' });
    if (!res.ok){
      console.warn('[nina] Request failed', url, res.status);
      return null;
    }
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!text || text.trim().startsWith('<') || !contentType.includes('application/json')){
      console.warn('[nina] Unexpected response', url, text ? text.slice(0, 140) : '<empty>');
      return null;
    }
    try{
      return JSON.parse(text);
    }catch(err){
      console.warn('[nina] Invalid JSON from', url, err?.message || err);
      return null;
    }
  }catch(err){
    console.warn('[nina] Fetch error', url, err?.message || err);
    return null;
  }
}

async function fetchGeoJsonStrict(url){
  const data = await fetchJsonStrict(url);
  if (!data) return null;
  const hasFeatures = Array.isArray(data.features) && data.features.length > 0;
  const hasGeometry = Boolean(data.geometry);
  if (!hasFeatures && !hasGeometry){
    console.warn('[nina] GeoJSON missing geometry', url);
    return null;
  }
  return data;
}

function bindTabs(){
  if (dom.tabs?.dwd){
    dom.tabs.dwd.onclick = ()=> activateTab('dwd');
  }
  if (dom.tabs?.nina){
    dom.tabs.nina.onclick = ()=> activateTab('nina');
  }
}

function activateTab(name){
  const isDwd = name === 'dwd';
  dom.tabs?.dwd?.classList.toggle('active', isDwd);
  dom.tabs?.nina?.classList.toggle('active', !isDwd);
  dom.tabs?.dwd?.setAttribute('aria-selected', isDwd ? 'true' : 'false');
  dom.tabs?.nina?.setAttribute('aria-selected', !isDwd ? 'true' : 'false');
  if (dom.panelDwd) dom.panelDwd.hidden = !isDwd;
  if (dom.panelNina) dom.panelNina.hidden = isDwd;
}

async function loadDwdWarnings(){
  try{
    const res = await fetch(DWD_WFS, { cache:'no-store' });
    if (!res.ok) throw new Error(`DWD WFS ${res.status}`);
    const data = await res.json();
    const features = Array.isArray(data?.features) ? data.features : [];
    allDwdFeatures = features;
    dwdLayer = buildDwdLayer(features);
    if (dom.chkDwd?.checked && dwdLayer){
      dwdLayer.addTo(mapRef);
    }
    refreshSidebar();
  }catch(err){
    console.warn('DWD warnings failed:', err);
    renderEmpty(dom.listDwd, 'Warnungen konnten nicht geladen werden.');
  }
}

async function loadNinaWarnings(){
  const mapData = await fetchJsonStrict('/nina/api31/mowas/mapData.json');
  if (!Array.isArray(mapData)){
    ninaListItems = [];
    if (dom.listNina) dom.listNina.innerHTML = '';
    renderEmpty(dom.listNina, 'Warnungen konnten nicht geladen werden.');
    return;
  }
  const normalized = mapData.map(normalizeNinaMapItem).filter(Boolean);
  normalized.sort((a, b) => safeTime(b.start) - safeTime(a.start));
  ninaListItems = normalized.slice(0, NINA_SIDEBAR_LIMIT);
  updateNinaSidebar(ninaListItems);
  refreshSidebar();
  enrichNinaDetails(ninaListItems.slice(0, NINA_DETAIL_LIMIT));
}

async function enrichNinaDetails(items){
  for (const item of items){
    if (!item?.id) continue;
    try{
      let detail = ninaDetailsCache.get(item.id);
      if (!detail){
        detail = await fetchJsonStrict(`/nina/api31/warnings/${encodeURIComponent(item.id)}.json`);
        if (detail) ninaDetailsCache.set(item.id, detail);
      }
      if (detail){
        applyNinaDetail(item, detail);
        updateNinaSidebar(ninaListItems);
      }
    }catch(err){
      console.warn('[nina] Detail fetch failed', item.id, err?.message || err);
    }
  }
}

function toggleDwdLayer(on){
  if (on){
    if (dwdLayer){
      dwdLayer.addTo(mapRef);
      refreshSidebar();
    }else{
      loadDwdWarnings();
    }
  }else if (dwdLayer){
    mapRef.removeLayer(dwdLayer);
    refreshSidebar();
  }
}

function toggleNinaLayer(on){
  if (on){
    (async ()=>{
      try{
        await (ninaLoadPromise || (ninaLoadPromise = loadNinaWarnings()));
        await ensureNinaLayer();
      }catch(err){
        console.warn('[nina] Toggle failed', err);
      }
    })();
  }else if (ninaLayer){
    mapRef.removeLayer(ninaLayer);
  }
}

async function ensureNinaLayer(){
  if (!mapRef) return;
  const items = Array.isArray(ninaListItems) ? ninaListItems : [];
  if (items.length === 0) return;
  const features = [];
  for (const item of items){
    if (!item?.id) continue;
    try{
      let geo = ninaGeometryCache.get(item.id);
      if (!geo){
        geo = await fetchGeoJsonStrict(`/nina/api31/warnings/${encodeURIComponent(item.id)}.geojson`);
        if (geo) ninaGeometryCache.set(item.id, geo);
      }
      if (!geo) continue;
      const enriched = toFeaturesWithProps(geo, item);
      if (enriched.length){
        features.push(...enriched);
        if (!item.feature){
          item.feature = enriched[0];
        }
      }
    }catch(err){
      console.warn('[nina] Geometry fetch failed', item.id, err?.message || err);
    }
  }
  ninaFeatures = features;
  if (ninaLayer){
    mapRef.removeLayer(ninaLayer);
  }
  ninaLayer = features.length ? buildNinaLayer(features) : null;
  if (ninaLayer && dom.chkNina?.checked){
    ninaLayer.addTo(mapRef);
  }
  updateNinaSidebar(ninaListItems);
}

let dwdStyleLogged = false;

function buildDwdLayer(features){
  if (!leafletRef || !Array.isArray(features)) return null;
  return leafletRef.geoJSON(features, {
    pane:'warnPane',
    style: feature => {
      const props = feature?.properties || {};
      const fill = deriveDwdColor(props);
      if (!dwdStyleLogged){
        const keys = Object.keys(props);
        console.debug('[dwd] style', { keys, fillColor: fill });
        dwdStyleLogged = true;
      }
      return {
        fillColor: fill,
        color: pickStrokeColor(fill),
        weight: 1,
        opacity: 0.8,
        fillOpacity: 0.45
      };
    },
    onEachFeature: (feature, layer)=>{
      layer.on('click', ()=>{
        const bounds = layer.getBounds();
        mapRef.fitBounds(bounds, { maxZoom: mapRef.getMaxZoom() - 1 });
      });
      const props = feature?.properties || {};
      const title = props.EVENT || props.HEADLINE || 'Wetterwarnung';
      const timeframe = formatTimeRange(props.ONSET || props.onset, props.EXPIRES || props.expires);
      const desc = props.DESCRIPTION || '';
      layer.bindPopup(`<div class="warn-popup"><strong>${title}</strong><br>${timeframe}<br>${desc}</div>`);
    }
  });
}

function buildNinaLayer(features){
  if (!leafletRef || !Array.isArray(features)) return null;
  return leafletRef.geoJSON(features, {
    pane:'warnPane',
    style: feature => {
      const sev = Number(feature?.properties?.severity) || 0;
      const color = WARNING_LEVEL_COLORS[sev] || '#555';
      return { color, weight:1, fillOpacity:0.35, fillColor:color };
    },
    onEachFeature: (feature, layer)=>{
      layer.on('click', ()=>{
        const bounds = layer.getBounds();
        if (bounds && bounds.isValid()){
          mapRef.fitBounds(bounds, { maxZoom: mapRef.getMaxZoom() - 1 });
        }
        const regionId = getNinaRegionId(feature);
        if (regionId){
          focusNinaCardByAgs(regionId);
        }
      });
      const props = feature?.properties || {};
      const headline = props.headline || props.event || 'Warnung';
      const desc = (props.description || '').replace(/\n/g,'<br>');
      const time = formatTimeRange(props.onset || props.effective, props.expires);
      layer.bindPopup(`<div class="warn-popup"><strong>${headline}</strong><br>${props.provider || 'NINA'}<br>${time}<br>${desc}</div>`);
    }
  });
}

function refreshSidebar(){
  if (!mapRef) return;
  const visibleWarnings = allDwdFeatures.filter(f => f?.geometry && mapRef.getBounds().intersects(leafletRef.geoJSON(f).getBounds()));
  updateDwdSidebar(visibleWarnings);
  const wantsSidebar = Boolean(dom.chkWarnList?.checked);
  setSidebarVisibility(wantsSidebar, { syncCheckbox:false });
}

function setSidebarVisibility(show, { syncCheckbox = true } = {}){
  if (!dom.listBox) return;
  dom.listBox.style.display = show ? 'block' : 'none';
  if (syncCheckbox && dom.chkWarnList){
    dom.chkWarnList.checked = show;
  }
}

function updateDwdSidebar(features){
  if (!dom.listDwd) return;
  dom.listDwd.innerHTML = '';
  if (!Array.isArray(features) || features.length === 0){
    renderEmpty(dom.listDwd, 'Keine Warnungen im aktuellen Kartenausschnitt');
    return;
  }
  const normalized = features.map(f => normalizeDwdFeature(f));
  normalized.sort(sortWarnings);
  normalized.forEach(item => dom.listDwd.appendChild(createCard(item, () => zoomToFeature(item.feature))));
}

function updateNinaSidebar(items){
  if (!dom.listNina) return;
  dom.listNina.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0){
    renderEmpty(dom.listNina, 'Derzeit keine aktiven Warnungen');
    return;
  }
  const normalized = items.map(normalizeNinaItemForCard).filter(Boolean);
  normalized.sort((a, b) => safeTime(b.start) - safeTime(a.start));
  normalized.forEach(item => dom.listNina.appendChild(createCard(item, () => zoomToFeature(item.feature))));
}

function renderEmpty(target, text){
  if (!target) return;
  const empty = document.createElement('div');
  empty.className = 'warn-empty hint';
  empty.textContent = text;
  target.appendChild(empty);
}

function createCard(warning, onClick){
  const card = document.createElement('div');
  const sev = warning.severity || 0;
  const sevColor = WARNING_LEVEL_COLORS[sev] || '#b3b3b3';
  card.className = `warn-card warn-card--sev-${sev}`;
  if (warning.id){
    card.dataset.warnId = String(warning.id);
  }
  if (warning.source === 'DWD' && warning.__dwdBg){
    card.style.background = warning.__dwdBg;
    if (warning.__dwdFg){
      card.style.color = warning.__dwdFg;
    }
    card.style.borderLeft = '6px solid rgba(0,0,0,.35)';
  }else{
    card.style.borderLeftColor = sevColor;
  }
  card.onclick = onClick;
  const regionId = getNinaRegionId(warning.feature);
  if (regionId){
    card.dataset.ags = String(regionId);
  }

  const header = document.createElement('div');
  header.className = 'warn-card__header';

  const title = document.createElement('div');
  title.className = 'warn-card__headline';
  title.textContent = warning.title || 'Warnung';
  if (sev){
    const sevBadge = document.createElement('span');
    sevBadge.className = `warn-card__severity warn-card__severity--${sev}`;
    sevBadge.textContent = `Stufe ${sev}`;
    sevBadge.style.backgroundColor = sevColor;
    header.appendChild(sevBadge);
  }
  header.appendChild(title);
  card.appendChild(header);

  const metaParts = [];
  if (warning.source) metaParts.push(warning.source);
  if (warning.area) metaParts.push(warning.area);
  if (warning.timeframe) metaParts.push(warning.timeframe);
  if (metaParts.length){
    const meta = document.createElement('div');
    meta.className = 'warn-card__meta hint';
    meta.textContent = metaParts.join(' • ');
    card.appendChild(meta);
  }

  if (warning.description){
    const desc = document.createElement('div');
    desc.className = 'warn-card__description';
    desc.textContent = warning.description;
    card.appendChild(desc);
  }

  return card;
}

function findNinaCardByAgs(agsRaw){
  if (!dom.listNina) return null;
  const ags = String(agsRaw ?? '');
  if (!ags) return null;
  const selector = `[data-ags="${escapeAttributeValue(ags)}"]`;
  try{
    return dom.listNina.querySelector(selector);
  }catch(err){
    console.warn('Fehler beim Selektieren eines NINA-Elements:', err);
    if (err?.stack) console.warn(err.stack);
    return null;
  }
}

function focusNinaCardByAgs(agsRaw){
  const card = findNinaCardByAgs(agsRaw);
  if (!card) return;
  card.scrollIntoView({ behavior:'smooth', block:'center' });
  card.classList.add('warn-card--active');
  setTimeout(() => card.classList.remove('warn-card--active'), 1500);
}

function normalizeDwdFeature(feature){
  const props = feature?.properties || {};
  const severity = parseSeverity(props);
  const dwdColor = parseEcAreaColor(props.EC_AREA_COLOR) || fallbackColorBySeverity(props.SEVERITY ?? severity);
  const dwdText = dwdColor ? pickTextColor(dwdColor) : null;
  return {
    feature,
    severity,
    title: props.EVENT || props.HEADLINE || 'Wetterwarnung',
    source: 'DWD',
    area: props.AREA || props.AREANAME || props.NAME || '',
    timeframe: formatTimeRange(props.ONSET || props.onset, props.EXPIRES || props.expires),
    description: props.DESCRIPTION || '',
    start: props.ONSET || props.onset || '',
    end: props.EXPIRES || props.expires || '',
    __dwdBg: dwdColor,
    __dwdFg: dwdText
  };
}

function normalizeNinaFeature(feature){
  const props = feature?.properties || {};
  const severity = ninaSeverityToLevel(props.severity ?? props.level);
  return {
    feature,
    severity,
    title: props.headline || props.event || 'Warnung',
    source: props.provider || props.source || 'NINA',
    area: props.regionName || props.rs || props.area || '',
    timeframe: formatTimeRange(props.onset || props.effective, props.expires),
    description: props.description || '',
    start: props.onset || props.effective || '',
    end: props.expires || ''
  };
}

function normalizeNinaMapItem(item){
  const id = item?.identifier || item?.id;
  if (!id) return null;
  const payload = item?.payload || {};
  const data = payload.data || item?.data || {};
  const info = Array.isArray(item?.info) ? item.info[0] : Array.isArray(data?.info) ? data.info[0] : null;
  const area = info?.area?.[0]?.areaDesc || data.areaDesc || item?.areaDesc || '';
  const severity = ninaSeverityToLevel(data.severity ?? item?.severity ?? info?.severity);
  const start = data.startDate || data.onset || item?.startDate || info?.onset || '';
  const end = data.endDate || data.expires || item?.endDate || info?.expires || '';
  return {
    id,
    start,
    end,
    severity,
    event: data.event || item?.event || info?.event || '',
    headline: data.headline || info?.headline || '',
    description: data.description || info?.description || '',
    source: item?.provider || item?.source || 'NINA',
    area,
    feature: null
  };
}

function normalizeNinaItemForCard(item){
  if (!item?.id) return null;
  return {
    id: item.id,
    feature: item.feature,
    severity: ninaSeverityToLevel(item.severity),
    title: item.headline || item.event || 'Warnung',
    source: item.source || 'NINA',
    area: item.area || '',
    timeframe: formatTimeRange(item.start, item.end),
    description: item.description || '',
    start: item.start,
    end: item.end
  };
}

function applyNinaDetail(target, detail){
  if (!target || !detail) return;
  const payload = detail?.payload || {};
  const data = payload.data || detail?.data || {};
  const info = Array.isArray(detail?.info) ? detail.info[0] : Array.isArray(data?.info) ? data.info[0] : null;
  target.headline = data.headline || info?.headline || target.headline;
  target.description = data.description || info?.description || target.description;
  target.event = data.event || info?.event || target.event;
  target.severity = ninaSeverityToLevel(data.severity ?? info?.severity ?? target.severity);
  target.start = data.startDate || data.onset || info?.onset || target.start;
  target.end = data.endDate || data.expires || info?.expires || target.end;
  target.area = info?.area?.[0]?.areaDesc || data.areaDesc || target.area;
}

function buildNinaProperties(item){
  return {
    severity: ninaSeverityToLevel(item?.severity),
    headline: item?.headline || item?.event || 'Warnung',
    event: item?.event,
    provider: item?.source || 'NINA',
    source: item?.source || 'NINA',
    description: item?.description || '',
    onset: item?.start,
    effective: item?.start,
    expires: item?.end,
    regionName: item?.area || ''
  };
}

function attachNinaProps(feature, item){
  const props = { ...(feature?.properties || {}), ...buildNinaProperties(item) };
  return { type:'Feature', geometry: feature.geometry, properties: props };
}

function toFeaturesWithProps(raw, item){
  const features = [];
  if (!raw) return features;
  if (Array.isArray(raw.features)){
    raw.features.forEach(f => features.push(attachNinaProps(f, item)));
    return features;
  }
  if (raw.type === 'Feature'){
    features.push(attachNinaProps(raw, item));
    return features;
  }
  if (raw.geometry){
    features.push(attachNinaProps({ type:'Feature', geometry: raw.geometry, properties:{} }, item));
  }
  return features;
}

function getNinaRegionId(feature){
  const props = feature?.properties || {};
  return props.ags ?? props.regionId ?? props.rs ?? props.regionCode ?? '';
}

function parseSeverity(props){
  const sev = Number(props?.SEVERITY ?? props?.severity ?? props?.LEVEL);
  return Number.isFinite(sev) ? sev : 0;
}

function ninaSeverityToLevel(value){
  const normalized = String(value ?? '').toLowerCase();
  switch(normalized){
    case 'extreme':
    case '4':
      return 4;
    case 'severe':
    case '3':
      return 3;
    case 'moderate':
    case '2':
      return 2;
    case 'minor':
    case '1':
      return 1;
    default:
      return Number.isFinite(Number(value)) ? Number(value) : 0;
  }
}

function sortWarnings(a, b){
  const sevDiff = Number(b?.severity || 0) - Number(a?.severity || 0);
  if (sevDiff !== 0) return sevDiff;
  const startA = safeTime(a?.start);
  const startB = safeTime(b?.start);
  return startA - startB;
}

function safeTime(value){
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function formatTimeRange(start, end){
  const startStr = formatTimestamp(start);
  const endStr = formatTimestamp(end);
  if (startStr && endStr) return `${startStr} – ${endStr}`;
  return startStr || endStr || '';
}

function formatTimestamp(value){
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function zoomToFeature(feature){
  if (!leafletRef || !mapRef || !feature?.geometry) return;
  const layer = leafletRef.geoJSON(feature);
  const bounds = layer.getBounds();
  if (bounds && bounds.isValid()){
    mapRef.fitBounds(bounds, { maxZoom: mapRef.getMaxZoom() - 1 });
  }
}
