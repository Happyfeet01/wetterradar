let layer = null;
let loading = null;

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

export async function setWindFlow(L, map, enabled){
  if(!enabled){
    if(layer){ map.removeLayer(layer); }
    return null;
  }
  if(layer){
    layer.addTo(map);
    return layer;
  }
  if(loading) return loading;

  loading = (async()=>{
    try{
      if(typeof L.velocityLayer !== 'function'){
        throw new Error('leaflet-velocity nicht geladen');
      }
      const payload = await fetchWindField();

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
        : { data: dataset };
      if(!map.getPane('windPane')){
        map.createPane('windPane');
        map.getPane('windPane').style.zIndex = 480;
      }
      const isMobile = /iphone|ipad|android|mobile/i.test(navigator.userAgent);
      layer = L.velocityLayer({
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
      layer.addTo(map);
      return layer;
    }catch(err){
      layer = null;
      throw err;
    }finally{
      loading = null;
    }
  })();

  return loading;
}
