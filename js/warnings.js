// warnings.js
// Aktualisierte Warnlogik: DWD-Polygone + BBK/NINA mit Sidebar und Tab-Navigation.
import { DWD_WFS } from './config.js';

const WARNING_LEVEL_COLORS = {
  1: '#ffff00',
  2: '#ffa500',
  3: '#ff0000',
  4: '#800080'
};

let mapRef = null;
let leafletRef = null;
let dwdLayer = null;
let ninaLayer = null;
let allDwdFeatures = [];
let ninaFeatures = [];
let sidebarTimer = null;

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
  loadNinaWarnings();
  if (dom.chkNina?.checked) toggleNinaLayer(true);
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
  try{
    const res = await fetch('/warnings/nina.geojson', { cache:'no-store' });
    if (!res.ok) throw new Error(`NINA GeoJSON ${res.status}`);
    const data = await res.json();
    const features = Array.isArray(data?.features) ? data.features : [];
    ninaFeatures = features;
    ninaLayer = buildNinaLayer(features);
    if (dom.chkNina?.checked && ninaLayer){
      ninaLayer.addTo(mapRef);
    }
    updateNinaSidebar(features);
    refreshSidebar();
  }catch(err){
    console.warn('NINA warnings failed:', err);
    renderEmpty(dom.listNina, 'Warnungen konnten nicht geladen werden.');
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
    if (ninaLayer){
      ninaLayer.addTo(mapRef);
    }else{
      loadNinaWarnings();
    }
  }else if (ninaLayer){
    mapRef.removeLayer(ninaLayer);
  }
}

function buildDwdLayer(features){
  if (!leafletRef || !Array.isArray(features)) return null;
  return leafletRef.geoJSON(features, {
    pane:'warnPane',
    style: feature => {
      const sev = parseSeverity(feature?.properties);
      const color = WARNING_LEVEL_COLORS[sev] || '#b3b3b3';
      return { color, weight:1.2, fillOpacity:0.3, fillColor:color };
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

function updateNinaSidebar(features){
  if (!dom.listNina) return;
  dom.listNina.innerHTML = '';
  if (!Array.isArray(features) || features.length === 0){
    renderEmpty(dom.listNina, 'Derzeit keine aktiven Warnungen');
    return;
  }
  const normalized = features.map(f => normalizeNinaFeature(f));
  normalized.sort(sortWarnings);
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
  card.style.borderLeftColor = sevColor;
  card.onclick = onClick;

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

function normalizeDwdFeature(feature){
  const props = feature?.properties || {};
  const severity = parseSeverity(props);
  return {
    feature,
    severity,
    title: props.EVENT || props.HEADLINE || 'Wetterwarnung',
    source: 'DWD',
    area: props.AREA || props.AREANAME || props.NAME || '',
    timeframe: formatTimeRange(props.ONSET || props.onset, props.EXPIRES || props.expires),
    description: props.DESCRIPTION || '',
    start: props.ONSET || props.onset || '',
    end: props.EXPIRES || props.expires || ''
  };
}

function normalizeNinaFeature(feature){
  const props = feature?.properties || {};
  return {
    feature,
    severity: Number(props.severity) || 0,
    title: props.headline || props.event || 'Warnung',
    source: props.provider || props.source || 'NINA',
    area: props.regionName || props.rs || props.area || '',
    timeframe: formatTimeRange(props.onset || props.effective, props.expires),
    description: props.description || '',
    start: props.onset || props.effective || '',
    end: props.expires || ''
  };
}

function parseSeverity(props){
  const sev = Number(props?.SEVERITY ?? props?.severity ?? props?.LEVEL);
  return Number.isFinite(sev) ? sev : 0;
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
