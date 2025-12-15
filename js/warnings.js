// warnings.js
// Aktualisierte Warnlogik: DWD-Polygone + BBK/NINA mit Sidebar und Tab-Navigation.
import { DWD_WFS } from './config.js';

const WARNING_LEVEL_COLORS = {
  1: '#ffff00',
  2: '#ffa500',
  3: '#ff0000',
  4: '#800080'
};

function parseEcAreaColor(value){
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(v => !Number.isFinite(v))) return null;
  const [r, g, b] = parts.map(v => Math.max(0, Math.min(255, Math.round(v))));
  return `rgb(${r},${g},${b})`;
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
  const dwdColor = parseEcAreaColor(props.EC_AREA_COLOR) || fallbackColorBySeverity(props.SEVERITY);
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

function getNinaRegionId(feature){
  const props = feature?.properties || {};
  return props.ags ?? props.regionId ?? props.rs ?? props.regionCode ?? '';
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
