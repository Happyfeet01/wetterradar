export const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_DARK_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
export const OSM_ATTRIB = '© OpenStreetMap-Mitwirkende';
export const OSM_DARK_ATTRIB = '© OpenStreetMap-Mitwirkende, © CARTO';

export const RV_API = '/rainviewer/weather-maps.json';
export const RV_HOST_FALLBACK = 'https://tilecache.rainviewer.com';
// RainViewer liefert die Radar- und Satelliten-Tiles inzwischen standardmäßig mit
// 512 px Kantenlänge aus. Mit 512er Tiles plus `zoomOffset:-1` wirken die Bilder
// schärfer und es verschwinden Artefakte/Muster, die durch das Herunterskalieren
// der 512er Tiles auf 256 px entstehen.
export const RADAR_SIZE = 512;
export const RADAR_ZOOM_OFFSET = -1;
export const PLAY_FADE_MS = 280;

export const DWD_WMS = 'https://maps.dwd.de/geoserver/dwd/ows?';
export const DWD_WMS_LAYER = 'dwd:Warnungen_Landkreise';
export const DWD_WARN_JSON = '/dwd/warnings.json';
export const DWD_WFS = 'https://maps.dwd.de/geoserver/dwd/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=dwd:Warnungen_Landkreise&outputFormat=application/json';

