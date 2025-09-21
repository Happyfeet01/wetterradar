// warnings.js
import { DWD_WMS, DWD_WMS_LAYER, DWD_WARN_JSON, DWD_WFS } from './config.js';

export function bind(L, map, ui){
  // --- Pane für Warn-Layer (über Radar/Wolken) ---
  map.createPane('warnPane');
  map.getPane('warnPane').style.zIndex = 510;

  let wms = null;

  // --- UI-Handler ---
  if (ui.chkWarn){
    ui.chkWarn.onchange = ()=> toggleWms(ui.chkWarn.checked);
  }
  if (ui.chkWarnList){
    ui.chkWarnList.onchange = ()=>{
      const box = document.getElementById('warnList');
      box.style.display = ui.chkWarnList.checked ? 'block' : 'none';
      if (ui.chkWarnList.checked) refreshList();
    };
  }

  const chkWarnInView = document.getElementById('chkWarnInView');
  if (chkWarnInView){
    chkWarnInView.onchange = ()=> refreshList();
  }
  // Bei Kartenbewegung neu filtern, wenn "nur im Kartenausschnitt" aktiv ist
  map.on('moveend', ()=>{
    const box = document.getElementById('warnList');
    if (box && box.style.display === 'block' && chkWarnInView?.checked){
      refreshList();
    } else {
      // Banner trotzdem aktuell halten
      refreshBannerOnly().catch(()=>{});
    }
  });

  // --- WMS Toggle ---
  function toggleWms(on){
    if(on){
      if(wms){ wms.addTo(map); return; }
      wms = L.tileLayer.wms(DWD_WMS, {
        pane:'warnPane',
        layers:DWD_WMS_LAYER,
        version:'1.3.0',
        crs:L.CRS.EPSG3857,
        format:'image/png',
        transparent:true,
        tiled:true,
        opacity:0.75,
        attribution:'Warnungen © DWD'
      }).addTo(map);
    } else if (wms){
      map.removeLayer(wms);
    }
  }

  // --- JSONP Loader für DWD WARNUNGEN (Firefox-sicher) ---
  function loadJsonp(src, timeoutMs = 8000){
    return new Promise((resolve, reject) => {
      let done = false, timer = null, tag = null;

      // DWD ruft warnWetter.loadWarnings({...}) auf
      window.warnWetter = {
        loadWarnings: (data) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          cleanup();
          resolve(data);
        }
      };

      function cleanup(){
        try { if (tag && tag.parentNode) tag.parentNode.removeChild(tag); } catch {}
        try { delete window.warnWetter; } catch {}
      }

      tag = document.createElement('script');
      tag.src = src + (src.includes('?') ? '&' : '?') + '_=' + Date.now(); // Cache-Buster
      tag.async = true;
      tag.onerror = () => { if (done) return; done = true; clearTimeout(timer); cleanup(); reject(new Error('JSONP load failed')); };
      document.head.appendChild(tag);

      timer = setTimeout(() => {
        if (done) return;
        done = true; cleanup();
        reject(new Error('JSONP timeout'));
      }, timeoutMs);
    });
  }

  async function fetchWarningsJson(){
    // Achtung: DWD liefert JSONP, nicht pures JSON
    const data = await loadJsonp(DWD_WARN_JSON);
    return data; // hat Felder: { time, warnings: { <id>: [warnObj, ...], ... }, ... }
  }

  // --- WFS: Warnflächen im aktuellen Kartenausschnitt (BBox) ---
  async function fetchWarnAreasInView(){
    // BBox in EPSG:4326 ermitteln (Leaflet liefert Bounds bereits als WGS84)
    const b = map.getBounds();
    const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()},EPSG:4326`;
    const url = `${DWD_WFS}&bbox=${bbox}&srsName=EPSG:4326`;

    const res = await fetch(url, { cache:'no-store' });
    if (!res.ok) throw new Error('WFS BBOX failed: ' + res.status);
    const geo = await res.json();
    const features = Array.isArray(geo?.features) ? geo.features : [];
    if (!features.length){
      console.error('WFS BBOX returned no features for bbox:', bbox);
      return { names: new Set(), ids: new Set(), featureCount: 0, bbox };
    }

    // Kandidaten für Regionsbezeichner/IDs sammeln
    const names = new Set();
    const ids   = new Set();
    for (const f of features) {
      const p = f.properties || {};
      ['regionName','NAME','GEN','KREIS','KREIS_NAME','KREISNAME','AREADESC'].forEach(k=>{
        if (typeof p[k] === 'string' && p[k].trim()) names.add(p[k].trim());
      });
      ['WARNCELLID','WARNCELL','RS','AGS','ID'].forEach(k=>{
        const v = p[k];
        if (v !== undefined && v !== null && String(v).trim()) ids.add(String(v).trim());
      });
    }
    return { names, ids, featureCount: features.length, bbox };
  }

  // --- Banner nur aktualisieren (ohne Liste zu rendern) ---
  async function refreshBannerOnly(){
    try{
      const js  = await fetchWarningsJson();
      const all = Object.values(js?.warnings || {}).flat();
      const banner = document.getElementById('noWarnBanner');
      if (banner) banner.style.display = all.length ? 'none' : 'block';
    }catch(e){
      const banner = document.getElementById('noWarnBanner');
      if (banner) banner.style.display = 'block';
      console.warn('DWD banner update failed:', e);
    }
  }

  // --- Liste + Banner rendern ---
  async function refreshList(){
    try{
      const js   = await fetchWarningsJson();
      let all    = Object.values(js?.warnings || {}).flat();

      // Bonus: nur Warnungen im aktuellen Kartenausschnitt
      const onlyView = document.getElementById('chkWarnInView')?.checked;
      if (onlyView){
        try{
          const { names, ids, featureCount, bbox } = await fetchWarnAreasInView();
          if (featureCount > 0 && (names.size || ids.size)){
            all = all.filter(w => {
              const rn  = (w.regionName || '').trim();
              const rid = String(w.regionId || w.regionID || w.region || w.warncellid || w.warncellID || '').trim();
              return (rn && names.has(rn)) || (rid && ids.has(rid));
            });
          } else if (featureCount > 0){
            console.warn('WFS features missing identifiers for bbox, skipping warning filter:', bbox);
          } else {
            console.error('No WFS features available to filter warnings for bbox:', bbox);
          }
        }catch(e){
          console.warn('WFS filter failed, falling back to unfiltered warnings:', e);
        }
      }

      // Banner zeigen/verstecken
      const banner = document.getElementById('noWarnBanner');
      if (banner) banner.style.display = all.length ? 'none' : 'block';

      // Wenn Liste nicht sichtbar, hier aufhören
      const box = document.getElementById('warnList');
      if (!box || box.style.display !== 'block') return;

      // Liste rendern
      const root = document.getElementById('warnItems');
      if (!root) return;
      root.innerHTML = '';

      if (!all.length){
        root.innerHTML = `<div class="hint">Derzeit keine aktiven Warnungen${onlyView ? ' im Kartenausschnitt' : ''}.</div>`;
        return;
      }

      // Sortierung: höchste Stufe zuerst
      all.sort((a,b)=>(Number(b.level||0) - Number(a.level||0)));

      const COLORS = {1:'#ffff00', 2:'#ffa500', 3:'#ff0000', 4:'#800080'};
      const EMO    = {1:'🟡',      2:'🟠',      3:'🔴',      4:'🟣'     };

      for (const w of all){
        const lvl   = Number(w.level || 0);
        const col   = COLORS[lvl] || '#ddd';
        const emo   = EMO[lvl]    || '🟦';
        const head  = w.headline || w.event || 'Wetterwarnung';
        const start = w.start ? new Date(w.start).toLocaleString() : '';
        const end   = w.end   ? new Date(w.end).toLocaleString()   : '';
        const txt   = (w.description || w.text || '').replace(/\n+/g,'<br>');
        const region= (w.regionName || '').trim();

        const div = document.createElement('div');
        div.className = 'warn-card';
        div.style.borderLeftColor = col;
        div.innerHTML = `
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;">
            <b>${emo} ${head}</b>
            <span class="hint">Stufe ${lvl}${region ? ' • ' + region : ''}</span>
          </div>
          <div class="hint" style="margin:2px 0 6px 0">${start}${end ? ' – ' + end : ''}</div>
          <div>${txt}</div>
        `;
        root.appendChild(div);
      }

    }catch(e){
      console.warn('DWD warnings failed:', e);
      const banner = document.getElementById('noWarnBanner');
      if (banner) banner.style.display = 'block';

      const box = document.getElementById('warnList');
      if (box && box.style.display === 'block'){
        const root = document.getElementById('warnItems');
        if (root) root.innerHTML = '<div class="hint">Warnungen konnten nicht geladen werden.</div>';
      }
    }
  }

  // --- regelmäßige Aktualisierung ---
  setInterval(()=>{ refreshBannerOnly(); if(document.getElementById('warnList')?.style.display==='block') refreshList(); }, 5*60*1000);

  // initial
  refreshBannerOnly();
  // Liste erst laden, wenn aktiv
  if (ui.chkWarnList?.checked) refreshList();
}
