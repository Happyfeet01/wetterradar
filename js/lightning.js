import { SSE_LIGHTNING, STRIKE_RETAIN_MS } from './config.js';

export function bind(L, map, ui){
  map.createPane('lightningPane');
  map.getPane('lightningPane').style.zIndex = 540;

  const layer = L.layerGroup([], { pane:'lightningPane' }).addTo(map);
  let enabled = !!ui.chkLightning?.checked;
  let strikes = []; // {lat,lon,time}

  if (ui.chkLightning){
    ui.chkLightning.onchange = ()=>{
      enabled = ui.chkLightning.checked;
      if (!enabled) layer.clearLayers();
    };
  }

  function marker(lat, lon){
    return L.circleMarker([lat, lon], {
      radius: 4, color:'#ff9800', fillColor:'#ffeb3b', fillOpacity:0.9, weight:1
    });
  }
  function fadeOut(m, ms=STRIKE_RETAIN_MS){
    const t0=performance.now();
    const tick=(now)=>{
      const p=Math.min(1,(now-t0)/ms), op=0.9*(1-p);
      m.setStyle({fillOpacity:op, opacity:op});
      if(p<1) requestAnimationFrame(tick); else layer.removeLayer(m);
    };
    requestAnimationFrame(tick);
  }
  function prune(){
    const cutoff = Date.now() - STRIKE_RETAIN_MS;
    strikes = strikes.filter(s => s.time >= cutoff);
  }
  function updateCounter(){
    prune();
    const b = map.getBounds();
    const n = strikes.filter(s => b.contains([s.lat, s.lon])).length;
    const el = document.getElementById('lightningCounter');
    if (el) el.textContent = `⚡ Blitze im Sichtbereich: ${n} (10 min)`;
  }

  function connect(){
    const es = new EventSource(SSE_LIGHTNING);
    es.onmessage = (ev)=>{
      try{
        const msg = JSON.parse(ev.data);
        if (msg.type === 'init'){
          (msg.strikes||[]).forEach(s=>{
            strikes.push(s);
            if (enabled){ const m=marker(s.lat,s.lon).addTo(layer); fadeOut(m, Math.max(10000, STRIKE_RETAIN_MS/2)); }
          });
          updateCounter();
        } else if (msg.type === 'strike'){
          const s = msg.strike; strikes.push(s);
          if (enabled){ const m=marker(s.lat,s.lon).addTo(layer); fadeOut(m, STRIKE_RETAIN_MS); }
          updateCounter();
        }
      }catch{}
    };
    es.onerror = ()=>{ es.close(); setTimeout(connect, 3000); };
  }

  connect();
  setInterval(updateCounter, 10000);
  map.on('moveend', updateCounter);
}
