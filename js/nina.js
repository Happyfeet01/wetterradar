const REFRESH_MS = 5 * 60 * 1000;

function severityColor(severity){
  const value = String(severity ?? '').toLowerCase();
  if(/extreme|hochrisiko|4/.test(value)) return '#c62828';
  if(/severe|schwer|stufe\s*3|3/.test(value)) return '#e53935';
  if(/moderate|mittel|2/.test(value)) return '#fb8c00';
  if(/minor|gering|1/.test(value)) return '#fdd835';
  if(/info|unknown|unbekannt/.test(value)) return '#90a4ae';
  return '#64b5f6';
}

function hasValidGeometry(feature){
  const geom = feature?.geometry;
  return !!geom && typeof geom.type === 'string' && Array.isArray(geom.coordinates);
}

function featureToGeoJson(feature){
  const props = feature.properties || {
    id: feature.id,
    severity: feature.severity,
    title: feature.title,
    category: feature.category,
    areas: feature.areas,
    sent: feature.sent,
    expires: feature.expires,
  };

  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: {
      id: props.id ?? feature.id,
      severity: props.severity,
      title: props.title,
      category: props.category,
      areas: props.areas || [],
      sent: props.sent,
      expires: props.expires,
    },
  };
}

function geometryIntersectsBounds(L, feature, bounds){
  try{
    const gj = L.geoJSON(feature);
    const fb = gj.getBounds();
    return fb.isValid() && bounds.intersects(fb);
  }catch{
    return false;
  }
}

function createPanel(){
  const panel = document.createElement('div');
  panel.id = 'ninaPanel';
  panel.className = 'nina-panel';
  panel.style.display = 'none';

  const header = document.createElement('div');
  header.className = 'nina-panel__header';
  const title = document.createElement('div');
  title.textContent = 'Warnungen (NINA)';
  const toggle = document.createElement('button');
  toggle.className = 'nina-panel__toggle';
  toggle.setAttribute('aria-expanded', 'true');
  toggle.textContent = '▾';
  header.appendChild(title);
  header.appendChild(toggle);

  const summary = document.createElement('div');
  summary.className = 'nina-panel__summary';
  summary.textContent = 'Keine Warnungen geladen';

  const list = document.createElement('div');
  list.className = 'nina-panel__list';

  const body = document.createElement('div');
  body.className = 'nina-panel__body';
  body.appendChild(summary);
  body.appendChild(list);

  panel.appendChild(header);
  panel.appendChild(body);

  toggle.onclick = ()=>{
    const collapsed = panel.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '▸' : '▾';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    updateWarnListTop(panel);
  };

  document.body.appendChild(panel);
  return { panel, summary, list, toggle, body };
}

function updateWarnListTop(panel){
  const legend = document.getElementById('legend');
  const warnList = document.getElementById('warnList');
  const baseTop = (legend?.offsetHeight || 0) + 10 + 8;

  if(panel){
    panel.style.top = `${baseTop}px`;
    const bodyHeight = panel.offsetHeight || 0;
    if(warnList){
      warnList.style.top = `${baseTop + bodyHeight + 8}px`;
    }
  }else if(warnList){
    warnList.style.top = `${baseTop}px`;
  }
}

export function initNinaWarnings(L, map, ui){
  const checkbox = ui?.chkNina;
  const { panel, summary, list } = createPanel();
  let enabled = false;
  let ninaLayer = null;
  let data = null;
  let loading = false;
  let refreshTimer = null;

  map.createPane('ninaPane');
  map.getPane('ninaPane').style.zIndex = 520;

  function ensureLayer(){
    if(ninaLayer) return ninaLayer;
    ninaLayer = L.geoJSON([], {
      pane: 'ninaPane',
      style: feature => ({
        color: '#ffffff',
        weight: 2,
        fillColor: severityColor(feature?.properties?.severity),
        fillOpacity: 0.4,
        opacity: 1,
      })
    });
    return ninaLayer;
  }

  function attachLayer(){
    if(!ninaLayer) ensureLayer();
    if(ninaLayer && !map.hasLayer(ninaLayer)) ninaLayer.addTo(map);
  }

  function detachLayer(){
    if(ninaLayer && map.hasLayer(ninaLayer)) map.removeLayer(ninaLayer);
  }

  function setLoading(text='Lade…'){
    summary.textContent = text;
  }

  function renderPanelItems(items){
    list.innerHTML = '';
    if(!items.length){
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'Keine Warnungen im Ausschnitt';
      list.appendChild(hint);
      return;
    }

    items.forEach(feature => {
      const props = feature.properties || {};
      const color = severityColor(props.severity);
      const card = document.createElement('div');
      card.className = 'nina-item';
      card.style.borderLeftColor = color;

      const title = document.createElement('div');
      title.className = 'nina-item__title';
      title.textContent = props.title || 'Warnung';

      const meta = document.createElement('div');
      meta.className = 'nina-item__meta';
      meta.textContent = props.severity ? `Schwere: ${props.severity}` : 'Schwere unbekannt';

      card.appendChild(title);
      card.appendChild(meta);

      card.onclick = ()=>{
        try{
          const bounds = L.geoJSON(feature).getBounds();
          if(bounds.isValid()) map.fitBounds(bounds.pad(0.1));
        }catch{
          // ignore
        }
      };

      list.appendChild(card);
    });
  }

  function applyFilter(){
    if(!enabled || !data) return;
    const bounds = map.getBounds();
    const features = (data.features || [])
      .filter(hasValidGeometry)
      .map(featureToGeoJson)
      .filter(f => geometryIntersectsBounds(L, f, bounds));

    setLoading(`${features.length} Warnung${features.length === 1 ? '' : 'en'} im Ausschnitt`);

    const layer = ensureLayer();
    layer.clearLayers();
    features.forEach(f => layer.addData(f));

    renderPanelItems(features);
    updateWarnListTop(panel);
  }

  async function loadData(){
    if(loading) return;
    loading = true;
    setLoading('Lade…');
    try{
      const res = await fetch('/warnings/nina.geojson', { cache: 'no-store' });
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if(!Array.isArray(json?.features)) throw new Error('Unerwartetes Format');
      data = json;
      if(enabled) applyFilter();
    }catch(err){
      console.error('NINA Warnungen konnten nicht geladen werden:', err);
      setLoading('Fehler beim Laden der Warnungen');
      list.innerHTML = '<div class="hint">Keine Daten verfügbar</div>';
    }finally{
      loading = false;
      updateWarnListTop(panel);
    }
  }

  function enable(){
    enabled = true;
    panel.style.display = 'block';
    updateWarnListTop(panel);
    attachLayer();
    loadData();
    applyFilter();
    refreshTimer = setInterval(loadData, REFRESH_MS);
  }

  function disable(){
    enabled = false;
    panel.style.display = 'none';
    detachLayer();
    if(ninaLayer) ninaLayer.clearLayers();
    if(refreshTimer){
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    updateWarnListTop(null);
  }

  checkbox?.addEventListener('change', ()=>{
    if(checkbox.checked) enable();
    else disable();
  });

  map.on('moveend', ()=>{ if(enabled) applyFilter(); });

  updateWarnListTop(null);
}
