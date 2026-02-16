export const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_DARK_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
export const OSM_ATTRIB = '© OpenStreetMap-Mitwirkende';
export const OSM_DARK_ATTRIB = '© OpenStreetMap-Mitwirkende, © CARTO';

export const RV_API = '/rainviewer/weather-maps.json';
export const RV_HOST_FALLBACK = 'https://tilecache.rainviewer.com';
// RainViewer Free-Tier-Einschränkungen (seit 2025):
// - Nur noch Radar-Past (kein Nowcast, kein Satellit)
// - Nur Farbschema 8 (Universal Blue)
// - Max Zoom 7
// - 100 Requests/IP/Minute
export const RADAR_SIZE = 512;
export const RADAR_ZOOM_OFFSET = -1;
export const PLAY_FADE_MS = 280;

export const DWD_WMS = 'https://maps.dwd.de/geoserver/dwd/ows?';
export const DWD_WMS_LAYER = 'dwd:Warnungen_Landkreise';
export const DWD_WARN_JSON = '/dwd/warnings.json';
export const DWD_WFS = 'https://maps.dwd.de/geoserver/dwd/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=dwd:Warnungen_Landkreise&outputFormat=application/json';

// DWD Satellitendaten (WMS) – ersetzt RainViewer IR-Satellit
export const DWD_SAT_WMS = 'https://maps.dwd.de/geoserver/dwd/wms?';
export const DWD_SAT_LAYER = 'dwd:SAT_WELT_KOMPOSIT';