let layer = null;
let loading = null;
let refreshTimer = null;
let overlayEnabled = false;
let lastMetaGenerated = null;

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

async function fetchWindField(){
  let resp = await fetch('/wind/current.json', { cache:'no-store' });
  if(!resp.ok){
    resp = await fetch('/wind/wind.json', { cache:'no-store' });
  }
  if(!resp.ok){
    throw new Error('Winddaten nicht verfügbar');
  }
  return await resp.json();
}

function normalizePayload(payload){
  const meta = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload.meta
    : null;
  const dataset = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : null;

  if(!meta || typeof meta !== 'object' || !Array.isArray(dataset) || dataset.length === 0){
    throw new Error('Ungültige Winddaten');
  }

  dataset.forEach((entry, idx)=>{
    if(!entry || typeof entry !== 'object'){
      throw new Error(`Ungültige Winddaten (Eintrag ${idx})`);
    }
    if(!entry.header || typeof entry.header !== 'object'){
      throw new Error(`Ungültige Winddaten (Header ${idx})`);
    }
    if(!Array.isArray(entry.data)){
      throw new Error(`Ungültige Winddaten (Daten ${idx})`);
    }
  });

  const pluginPayload = payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray(payload.data)
    ? payload
    : { meta, data: dataset };

  return { meta, pluginPayload };
}

function createVelocityLayer(L, pluginPayload, isMobile){
  return L.velocityLayer({
    data: pluginPayload,
    pane: 'windPane',
    velocityScale:0.008,
    maxVelocity:25,
    lineWidth: isMobile ? 0.8 : 1.0,
    particleMultiplier: isMobile ? 1/350 : 1/200,
    displayValues:true,
    displayOptions:{
      position:'bottomleft',
      emptyString:'Keine Winddaten',
      velocityType:'Wind',
      speedUnit:'m/s',
      directionString:'Richtung'
    }
  });
}

function formatGeneratedLabel(generated){
  if(typeof generated !== 'string' || !generated) return '';
  const dt = new Date(generated);
  if(Number.isNaN(dt.getTime())) return generated;
  return dt.toLocaleString('de-DE', { hour12:false });
}

function ensureTimestampElement(){
  if(!layer || !layer._map || typeof document === 'undefined') return null;
  if(layer._windTimestampEl && layer._windTimestampEl.isConnected) return layer._windTimestampEl;
  const mapContainer = layer._map.getContainer?.();
  if(!mapContainer) return null;
  const control = mapContainer.querySelector('.leaflet-control-velocity');
  if(!control) return null;
  const el = document.createElement('div');
  el.className = 'leaflet-control-velocity-timestamp';
  el.style.marginTop = '4px';
  el.style.fontSize = '0.85em';
  el.style.opacity = '0.75';
  control.appendChild(el);
  layer._windTimestampEl = el;
  return el;
}

function updateTimestampDisplay(meta){
  if(typeof window === 'undefined') return;
  const el = ensureTimestampElement();
  if(!el) return;
  const text = formatGeneratedLabel(meta?.generated);
  if(text){
    el.textContent = `Stand: ${text}`;
    el.style.display = '';
  }else{
    el.textContent = '';
    el.style.display = 'none';
  }
}

function applyMeta(meta){
  const generated = typeof meta?.generated === 'string' ? meta.generated : null;
  const changed = generated !== lastMetaGenerated;
  lastMetaGenerated = generated;

  if(layer && typeof layer.options === 'object'){
    layer._windMeta = meta ?? null;
    if(layer.options.displayOptions){
      layer.options.displayOptions.timeLabel = generated || '';
    }
    if(layer.options.data && typeof layer.options.data === 'object'){
      layer.options.data.meta = meta ?? null;
    }
  }

  if(typeof window !== 'undefined'){
    setTimeout(()=> updateTimestampDisplay(meta), 0);
  }

  if(changed && generated){
    console.info('Windströmung aktualisiert:', generated);
  }
}

async function ensureWindLayer(L, map){
  if(loading) return loading;

  loading = (async()=>{
    try{
      if(typeof L.velocityLayer !== 'function'){
        throw new Error('leaflet-velocity nicht geladen');
      }
      const payload = await fetchWindField();
      const { meta, pluginPayload } = normalizePayload(payload);

      if(!map.getPane('windPane')){
        map.createPane('windPane');
        map.getPane('windPane').style.zIndex = 480;
      }

      const isMobile = /iphone|ipad|android|mobile/i.test(navigator.userAgent);

      if(!layer){
        layer = createVelocityLayer(L, pluginPayload, isMobile);
      }else if(typeof layer.setData === 'function'){
        layer.setData(pluginPayload);
      }else{
        if(map.hasLayer(layer)){
          map.removeLayer(layer);
        }
        layer = createVelocityLayer(L, pluginPayload, isMobile);
      }

      if(layer && layer.options){
        layer.options.data = pluginPayload;
      }

      if(layer && overlayEnabled && !map.hasLayer(layer)){
        layer.addTo(map);
      }

      applyMeta(meta);
      return layer;
    }catch(err){
      throw err;
    }finally{
      loading = null;
    }
  })();

  return loading;
}

function stopAutoRefresh(){
  if(refreshTimer){
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleAutoRefresh(L, map){
  if(!(REFRESH_INTERVAL_MS > 0)) return;
  stopAutoRefresh();
  refreshTimer = setInterval(()=>{
    if(!overlayEnabled || !layer) return;
    ensureWindLayer(L, map).catch(err=>{
      console.warn('Windströmung konnte nicht aktualisiert werden:', err);
    });
  }, REFRESH_INTERVAL_MS);
}

export async function setWindFlow(L, map, enabled){
  if(!enabled){
    overlayEnabled = false;
    stopAutoRefresh();
    if(layer && map.hasLayer(layer)){
      map.removeLayer(layer);
    }
    if(layer && layer._windTimestampEl){
      if(typeof layer._windTimestampEl.remove === 'function'){
        layer._windTimestampEl.remove();
      }
      layer._windTimestampEl = null;
    }
    return null;
  }

  overlayEnabled = true;
  try{
    if(loading){
      try{
        await loading;
      }catch(err){
        console.warn('Vorheriger Winddatenabruf fehlgeschlagen:', err);
      }
    }
    const result = await ensureWindLayer(L, map);
    if(layer && overlayEnabled && !map.hasLayer(layer)){
      layer.addTo(map);
    }
    if(result){
      scheduleAutoRefresh(L, map);
    }
    return result;
  }catch(err){
    overlayEnabled = false;
    stopAutoRefresh();
    throw err;
  }
}
