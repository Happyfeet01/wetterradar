const LOG_ENDPOINT = '/client-log';
const FLUSH_INTERVAL_MS = 3000;
const MAX_QUEUE = 100;
const MAX_RECENT = 200;
const MAX_STRING = 4000;
const SAFE_QUERY_KEYS = new Set(['service','request','layers','layer','time','_refresh','version','format','styles','crs','bbox','width','height']);

const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
const queue = [];
const recent = [];
let flushTimer = null;
let installed = false;
let fetchInstalled = false;

function makeSessionId(){
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
const sessionId = makeSessionId();

function errorToObject(err){
  if (!err) return null;
  if (err instanceof Error) return {
    name: String(err.name || 'Error').slice(0, 120),
    message: String(err.message || '').slice(0, MAX_STRING),
    stack: String(err.stack || '').slice(0, 12000),
  };
  return null;
}

function safeValue(value, depth = 0){
  if (depth > 3) return '[depth-limit]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  const asError = errorToObject(value);
  if (asError) return asError;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeValue(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      if (/token|password|secret|authorization|cookie/i.test(key)) out[key] = '[redacted]';
      else out[key] = safeValue(item, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING);
}

export function sanitizeUrl(input){
  try {
    const base = typeof location !== 'undefined' ? location.href : 'https://wetter.invalid/';
    const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input), base);
    const params = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if (SAFE_QUERY_KEYS.has(key.toLowerCase())) params.append(key, value);
      else params.append(key, '[redacted]');
    }
    const query = params.toString();
    return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return '[invalid-url]';
  }
}

function pageInfo(){
  if (typeof location === 'undefined') return null;
  return `${location.origin}${location.pathname}`;
}

function addRecent(record){
  recent.push(record);
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
}

function enqueue(record){
  addRecent(record);
  queue.push(record);
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  scheduleFlush();
}

function scheduleFlush(){
  if (flushTimer || typeof window === 'undefined') return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushLogs();
  }, FLUSH_INTERVAL_MS);
}

function makeRecord(level, source, event, data){
  return {
    ts: new Date().toISOString(),
    level,
    source,
    event,
    session: sessionId,
    page: pageInfo(),
    data: safeValue(data),
  };
}

export function log(level, source, event, data = null){
  enqueue(makeRecord(level, source, event, data));
}

export const logger = {
  debug: (source, event, data) => log('debug', source, event, data),
  info: (source, event, data) => log('info', source, event, data),
  warn: (source, event, data) => log('warn', source, event, data),
  error: (source, event, data) => log('error', source, event, data),
};

export async function flushLogs({ beacon = false } = {}){
  if (!queue.length || typeof window === 'undefined') return true;
  const batch = queue.splice(0, queue.length);
  const body = JSON.stringify({ records: batch });

  try {
    if (beacon && navigator?.sendBeacon) {
      const ok = navigator.sendBeacon(LOG_ENDPOINT, new Blob([body], { type: 'application/json' }));
      if (ok) return true;
    }
    if (!nativeFetch) throw new Error('fetch unavailable');
    const res = await nativeFetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`logger HTTP ${res.status}`);
    return true;
  } catch {
    queue.unshift(...batch.slice(-MAX_QUEUE));
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    return false;
  }
}

function consoleArgs(args){
  return args.map(arg => safeValue(arg));
}

function installConsoleCapture(){
  if (typeof console === 'undefined') return;
  for (const level of ['log','info','warn','error']) {
    const original = console[level]?.bind(console);
    if (!original || original.__wetterWrapped) continue;
    const wrapped = (...args) => {
      original(...args);
      enqueue(makeRecord(level === 'log' ? 'debug' : level, 'console', level, { args: consoleArgs(args) }));
    };
    wrapped.__wetterWrapped = true;
    console[level] = wrapped;
  }
}

function responseHeaders(res){
  const names = ['content-type','cache-control','age','etag','last-modified','x-wetter-cache','x-wetter-upstream'];
  const out = {};
  for (const name of names) {
    const value = res?.headers?.get?.(name);
    if (value != null) out[name] = value;
  }
  return out;
}

function installFetchCapture(){
  if (fetchInstalled || typeof window === 'undefined' || !nativeFetch) return;
  fetchInstalled = true;
  window.fetch = async (input, init = {}) => {
    const url = sanitizeUrl(input);
    let pathname = '';
    try { pathname = new URL(url, location.href).pathname; } catch {}
    if (pathname === LOG_ENDPOINT) return nativeFetch(input, init);

    const started = performance.now();
    const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    logger.debug('network', 'fetch.start', { method, url });
    try {
      const res = await nativeFetch(input, init);
      const durationMs = Math.round(performance.now() - started);
      const level = res.ok ? 'debug' : 'warn';
      log(level, 'network', 'fetch.end', {
        method,
        url,
        status: res.status,
        ok: res.ok,
        durationMs,
        headers: responseHeaders(res),
      });
      return res;
    } catch (err) {
      logger.error('network', 'fetch.error', {
        method,
        url,
        durationMs: Math.round(performance.now() - started),
        error: err,
      });
      throw err;
    }
  };
}

function layerKind(layer){
  return layer?.constructor?.name || 'LeafletLayer';
}

function layerUrl(layer){
  const raw = layer?._url || layer?._src || null;
  return raw ? sanitizeUrl(raw) : null;
}

export function bindLeafletLogging(map){
  if (!map?.on) return;
  logger.info('leaflet', 'map.ready', {
    version: globalThis.L?.version ?? null,
    center: map.getCenter?.(),
    zoom: map.getZoom?.(),
  });

  const observed = new WeakSet();
  const observeLayer = layer => {
    if (!layer || observed.has(layer)) return;
    observed.add(layer);
    const kind = layerKind(layer);
    const url = layerUrl(layer);
    const isTileLayer = typeof layer.getTileUrl === 'function';

    if (typeof layer.on === 'function') {
      layer.on('tileerror', ev => logger.error('leaflet', 'tile.error', {
        layer: kind,
        url: sanitizeUrl(ev?.tile?.src || url || ''),
        coords: ev?.coords ?? null,
        error: ev?.error ?? null,
      }));
      layer.on('error', ev => logger.error('leaflet', 'layer.error', {
        layer: kind,
        url,
        error: ev?.error ?? ev ?? null,
      }));
      if (!isTileLayer && url) {
        layer.on('load', () => logger.info('leaflet', 'image.load', { layer: kind, url: layerUrl(layer) || url }));
      }
    }
  };

  map.eachLayer?.(observeLayer);
  map.on('layeradd', ev => {
    observeLayer(ev.layer);
    logger.debug('leaflet', 'layer.add', { layer: layerKind(ev.layer), url: layerUrl(ev.layer) });
  });
  map.on('layerremove', ev => logger.debug('leaflet', 'layer.remove', { layer: layerKind(ev.layer), url: layerUrl(ev.layer) }));
  map.on('zoomend', () => logger.debug('leaflet', 'map.zoom', { zoom: map.getZoom?.() }));
  map.on('moveend', () => logger.debug('leaflet', 'map.move', { center: map.getCenter?.(), zoom: map.getZoom?.() }));
}

function installResourceErrorCapture(){
  window.addEventListener('error', ev => {
    const target = ev.target;
    if (target && target !== window) {
      const resourceUrl = target.currentSrc || target.src || target.href || null;
      if (resourceUrl) {
        logger.error('browser', 'resource.error', {
          tag: target.tagName || null,
          url: sanitizeUrl(resourceUrl),
        });
        return;
      }
    }

    logger.error('browser', 'window.error', {
      message: ev.message,
      filename: sanitizeUrl(ev.filename || ''),
      lineno: ev.lineno,
      colno: ev.colno,
      error: ev.error,
    });
  }, true);
}

export function installGlobalLogging(){
  if (installed || typeof window === 'undefined') return;
  installed = true;
  installConsoleCapture();
  installFetchCapture();
  installResourceErrorCapture();

  window.addEventListener('unhandledrejection', ev => logger.error('browser', 'unhandledrejection', { reason: ev.reason }));
  window.addEventListener('pagehide', () => { void flushLogs({ beacon: true }); });
  window.addEventListener('online', () => logger.info('browser', 'online'));
  window.addEventListener('offline', () => logger.warn('browser', 'offline'));

  logger.info('app', 'session.start', {
    userAgent: navigator?.userAgent ?? null,
    language: navigator?.language ?? null,
    online: navigator?.onLine ?? null,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
  });
}

export function getRecentLogs(){ return recent.slice(); }
export function getSessionId(){ return sessionId; }

export const __test = { safeValue, makeRecord, responseHeaders, layerUrl };
