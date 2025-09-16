export const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

export const RV_API = 'https://api.rainviewer.com/public/weather-maps.json';
export const RV_HOST_FALLBACK = 'https://tilecache.rainviewer.com';
export const RADAR_SIZE = 256;
export const PLAY_FADE_MS = 280;

export const DWD_WMS = 'https://maps.dwd.de/geoserver/dwd/ows?';
export const DWD_WMS_LAYER = 'dwd:Warnungen_Landkreise';
export const DWD_WARN_JSON = '/dwd/warnings.json';
export const DWD_WFS = 'https://maps.dwd.de/geoserver/dwd/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=dwd:Warnungen_Landkreise&outputFormat=application/json';

export const SSE_LIGHTNING = '/blitze';       // dein Proxy via Nginx
export const STRIKE_RETAIN_MS = 10 * 60 * 1000; // 10 Minuten
