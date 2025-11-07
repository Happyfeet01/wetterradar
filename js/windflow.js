let layer = null;
let loading = null;
let refreshTimer = null;
let overlayEnabled = false;
let lastMetaGenerated = null;
let lastWindData = null;
let lastFetchTime = 0;

// Zeitintervalle in Millisekunden
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 Minuten
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 Minuten

async function fetchWindData() {
  const now = Date.now();
  if (lastWindData && (now - lastFetchTime) < CACHE_DURATION_MS) {
    return lastWindData;
  }

  try {
    let resp = await fetch('/wind/current.json', { cache: 'no-store' });
    if (!resp.ok) {
      resp = await fetch('/wind/wind.json', { cache: 'no-store' });
    }
    if (!resp.ok) {
      console.warn('Winddaten nicht verfügbar');
      return lastWindData || null;
    }
    const data = await resp.json();
    lastWindData = data;
    lastFetchTime = now;
    return data;
  } catch (err) {
    console.warn('Fehler beim Laden der Winddaten:', err);
    return lastWindData || null;
  }
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    console.warn('Ungültige Winddaten');
    return { meta: null, pluginPayload: null };
  }

  const dataset = Array.isArray(payload.data) ? payload.data : [];
  if (!Array.isArray(dataset) || dataset.length === 0) {
    console.warn('Keine gültigen Winddaten');
    return { meta: null, pluginPayload: null };
  }

  // Daten explizit validieren und anpassen
  const validatedData = dataset.map(entry => {
    if (!entry || !entry.header || !entry.data) {
      return null;
    }
    return {
      header: entry.header,
      data: Array.isArray(entry.data) ? entry.data : []
    };
  }).filter(entry => entry !== null);

  if (validatedData.length === 0) {
    console.warn('Keine gültigen Winddaten nach Validierung');
    return { meta: null, pluginPayload: null };
  }

  return { meta: payload.meta, pluginPayload: { ...payload, data: validatedData } };
}

function isMobileDevice() {
  if (typeof navigator === 'undefined' || typeof navigator.userAgent !== 'string') return false;
  return /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent);
}

function createVelocityLayer(L, pluginPayload, isMobile, isDarkMode = false, zoomLevel = 10) {
  if (!pluginPayload || !Array.isArray(pluginPayload.data) || pluginPayload.data.length === 0) {
    console.warn("Keine gültigen Winddaten für die Darstellung verfügbar.");
    return L.layerGroup();
  }
  
  const particleMultiplier = isMobile
    ? 1 / (200 + (zoomLevel * 10))
    : 1 / (100 + (zoomLevel * 5));
  
  const colorScale = isDarkMode
    ? ['#00FFFF', '#00AAFF', '#FF00FF', '#FF5500', '#FFFF00']
    : ['#00FFFF', '#0000FF', '#FF00FF', '#FF0000', '#FFFF00'];
  
  // Daten explizit anpassen, um sicherzustellen, dass sie das erwartete Format haben
  const data = pluginPayload.data.map(entry => {
    return {
      header: entry.header,
      data: entry.data
    };
  });

  return L.velocityLayer({
    data: { ...pluginPayload, data },
    pane: 'windPane',
    velocityScale: 0.008,
    maxVelocity: 25,
    lineWidth: isMobile ? 1.2 : 1.5,
    particleMultiplier: particleMultiplier,
    colorScale: colorScale,
    displayValues: true,
    displayOptions: {
      position: 'bottomleft',
      emptyString: 'Keine Winddaten',
      velocityType: 'Wind',
      speedUnit: 'm/s',
      directionString: 'Richtung',
      color: isDarkMode ? '#FFFFFF' : '#000000',
      backgroundColor: isDarkMode ? '#000000' : '#FFFFFF',
    }
  });
}

function cleanupWindLayerInstance(targetLayer, map) {
  if (!targetLayer) return;
  if (targetLayer._windTimestampEl && typeof targetLayer._windTimestampEl.remove === 'function') {
    targetLayer._windTimestampEl.remove();
  }
  targetLayer._windTimestampEl = null;
  if (map && typeof map.hasLayer === 'function' && map.hasLayer(targetLayer)) {
    map.removeLayer(targetLayer);
  } else if (typeof targetLayer.remove === 'function' && targetLayer._map) {
    targetLayer.remove();
  }
  if (targetLayer === layer) {
    layer = null;
  }
}

function resolveVelocityLayer(L, map, pluginPayload, isDarkMode = false, zoomLevel = 10) {
  const isMobile = isMobileDevice();
  let nextLayer = layer;

  if (nextLayer && typeof nextLayer.setData === 'function') {
    if (!pluginPayload || !Array.isArray(pluginPayload.data) || pluginPayload.data.length === 0) {
      console.warn("Keine gültigen Winddaten für die Darstellung verfügbar.");
      nextLayer = L.layerGroup();
    } else {
      const data = pluginPayload.data.map(entry => {
        if (!entry || !entry.header || !entry.data) {
          return null;
        }
        return {
          header: entry.header,
          data: entry.data
        };
      }).filter(entry => entry !== null);
      
      if (data.length === 0) {
        console.warn("Keine gültigen Winddaten nach Filterung.");
        nextLayer = L.layerGroup();
      } else {
        nextLayer.setData({ ...pluginPayload, data });
      }
    }
  } else {
    if (nextLayer) {
      cleanupWindLayerInstance(nextLayer, map);
    }
    nextLayer = createVelocityLayer(L, pluginPayload, isMobile, isDarkMode, zoomLevel);
  }

  if (nextLayer && nextLayer.options) {
    nextLayer.options.data = pluginPayload;
    nextLayer.options.lineWidth = isMobile ? 1.2 : 1.5;
    nextLayer.options.particleMultiplier = isMobile
      ? 1 / (200 + (zoomLevel * 10))
      : 1 / (100 + (zoomLevel * 5));
    nextLayer.options.colorScale = isDarkMode
      ? ['#00FFFF', '#00AAFF', '#FF00FF', '#FF5500', '#FFFF00']
      : ['#00FFFF', '#0000FF', '#FF00FF', '#FF0000', '#FFFF00'];
    nextLayer.options.displayOptions.color = isDarkMode ? '#FFFFFF' : '#000000';
    nextLayer.options.displayOptions.backgroundColor = isDarkMode ? '#000000' : '#FFFFFF';
  }

  layer = nextLayer;
  return nextLayer;
}

function formatGeneratedLabel(generated) {
  if (typeof generated !== 'string' || !generated) return '';
  const dt = new Date(generated);
  if (Number.isNaN(dt.getTime())) return generated;
  return dt.toLocaleString('de-DE', { hour12: false });
}

function ensureTimestampElement() {
  if (!layer || !layer._map || typeof document === 'undefined') return null;
  if (layer._windTimestampEl && layer._windTimestampEl.isConnected) return layer._windTimestampEl;
  const mapContainer = layer._map.getContainer?.();
  if (!mapContainer) return null;
  const control = mapContainer.querySelector('.leaflet-control-velocity');
  if (!control) return null;
  const el = document.createElement('div');
  el.className = 'leaflet-control-velocity-timestamp';
  el.style.marginTop = '4px';
  el.style.fontSize = '0.85em';
  el.style.opacity = '0.75';
  control.appendChild(el);
  layer._windTimestampEl = el;
  return el;
}

function updateTimestampDisplay(meta) {
  if (typeof window === 'undefined') return;
  const el = ensureTimestampElement();
  if (!el) return;
  const text = formatGeneratedLabel(meta?.generated);
  if (text) {
    el.textContent = `Stand: ${text}`;
    el.style.display = '';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

function applyMeta(meta) {
  const generated = typeof meta?.generated === 'string' ? meta.generated : null;
  const changed = generated !== lastMetaGenerated;
  lastMetaGenerated = generated;

  if (layer && typeof layer.options === 'object') {
    layer._windMeta = meta ?? null;
    if (layer.options.displayOptions) {
      layer.options.displayOptions.timeLabel = generated || '';
    }
    if (layer.options.data && typeof layer.options.data === 'object') {
      layer.options.data.meta = meta ?? null;
    }
  }

  if (typeof window !== 'undefined') {
    setTimeout(() => updateTimestampDisplay(meta), 0);
  }

  if (changed && generated) {
    console.info('Windströmung aktualisiert:', generated);
  }
}

async function ensureWindLayer(L, map, { forceFetch = false, isDarkMode = false, zoomLevel = 10 } = {}) {
  if (loading) {
    if (forceFetch) {
      try {
        await loading;
      } catch (err) {
        console.warn('Vorheriger Winddatenabruf fehlgeschlagen:', err);
      }
    } else {
      return loading;
    }
  }

  loading = (async () => {
    try {
      if (typeof L.velocityLayer !== 'function') {
        console.warn('leaflet-velocity nicht geladen');
        return null;
      }
      const payload = await fetchWindData();
      if (!payload) return null;
      
      const { meta, pluginPayload } = normalizePayload(payload);
      if (!pluginPayload) return null;

      if (!map.getPane('windPane')) {
        map.createPane('windPane');
        map.getPane('windPane').style.zIndex = 480;
      }

      const nextLayer = resolveVelocityLayer(L, map, pluginPayload, isDarkMode, zoomLevel);

      if (nextLayer && overlayEnabled && map && !map.hasLayer(nextLayer)) {
        nextLayer.addTo(map);
      }

      applyMeta(meta);
      return nextLayer;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleAutoRefresh(L, map, isDarkMode = false) {
  if (!(REFRESH_INTERVAL_MS > 0)) return;
  stopAutoRefresh();
  refreshTimer = setInterval(async () => {
    if (!overlayEnabled || !layer) return;
    try {
      const payload = await fetchWindData();
      if (!payload) return;
      
      const { meta, pluginPayload } = normalizePayload(payload);
      if (!pluginPayload) return;

      if (layer && typeof layer.setData === 'function') {
        const data = pluginPayload.data.map(entry => {
          if (!entry || !entry.header || !entry.data) {
            return null;
          }
          return {
            header: entry.header,
            data: entry.data
          };
        }).filter(entry => entry !== null);
        
        if (data.length > 0) {
          layer.setData({ ...pluginPayload, data });
          applyMeta(meta);
        }
      }
    } catch (err) {
      console.warn('Windströmung konnte nicht aktualisiert werden:', err);
    }
  }, REFRESH_INTERVAL_MS);
}

export async function setWindFlow(L, map, enabled, isDarkMode = false) {
  if (!enabled) {
    overlayEnabled = false;
    stopAutoRefresh();
    if (layer && map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
    if (layer && layer._windTimestampEl) {
      if (typeof layer._windTimestampEl.remove === 'function') {
        layer._windTimestampEl.remove();
      }
      layer._windTimestampEl = null;
    }
    return null;
  }

  overlayEnabled = true;
  try {
    const zoomLevel = map.getZoom();
    const result = await ensureWindLayer(L, map, { forceFetch: true, isDarkMode, zoomLevel });
    if (result) {
      scheduleAutoRefresh(L, map, isDarkMode);
      map.on('zoomend', () => {
        const newZoomLevel = map.getZoom();
        if (layer && typeof layer.setOptions === 'function') {
          layer.setOptions({
            particleMultiplier: isMobileDevice()
              ? 1 / (200 + (newZoomLevel * 10))
              : 1 / (100 + (newZoomLevel * 5))
          });
        }
      });
    }
    return result;
  } catch (err) {
    overlayEnabled = false;
    stopAutoRefresh();
    throw err;
  }
}

/**
 * Erstellt ein großes Pin-Icon für den Standort.
 * @param {boolean} isDarkMode - Ob das Icon für Darkmode angepasst werden soll
 * @returns {L.Icon} Leaflet-Icon
 */
export function createLargePinIcon(isDarkMode = false) {
  return L.icon({
    iconUrl: isDarkMode ? '/images/pin-icon-dark.png' : '/images/pin-icon.png',
    iconSize: [40, 40],
    iconAnchor: [20, 40],
    popupAnchor: [0, -40],
  });
}

/**
 * Lädt DWD-Warnungen und zeigt sie als anklickbare Marker auf der Karte an.
 * @param {L.Map} map - Leaflet-Karteninstanz
 */
export async function loadDwdWarnings(L, map) {
  try {
    const response = await fetch('https://wetter.larsmueller.net/dwd/warnings.json');
    if (!response.ok) throw new Error('Warnungen nicht verfügbar');

    const warnings = await response.json();
    if (!Array.isArray(warnings)) {
      console.warn('Ungültiges Warnungsformat');
      return;
    }

    warnings.forEach(warning => {
      if (!warning.lat || !warning.lon) return;

      const marker = L.marker([warning.lat, warning.lon], {
        icon: L.icon({
          iconUrl: '/images/warning-icon.png',
          iconSize: [32, 32],
          iconAnchor: [16, 32],
        }),
      }).addTo(map);

      marker.on('click', () => {
        const popup = L.popup()
          .setLatLng([warning.lat, warning.lon])
          .setContent(`<b>${warning.headline}</b><br>${warning.description}`)
          .openOn(map);
      });
    });
  } catch (err) {
    console.error('Fehler beim Laden der Warnungen:', err);
  }
}