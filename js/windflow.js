// Erzeugt einen Windströmungs-Layer aus /wind/current.json und bindet ihn an eine Checkbox
export function bindWindFlow(L, map, ui) {
  const checkbox = ui?.chkWindFlow || document.querySelector('#chkWindFlow');
  if (!checkbox) {
    console.error('Wind-Checkbox (#chkWindFlow) nicht gefunden.');
    return;
  }

  let velocityLayer = null;
  let windPayload = null;
  let loadPromise = null;

  // Windströmung ist initial deaktiviert
  checkbox.checked = false;
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) {
      enableLayer();
    } else {
      disableLayer();
    }
  });

  function disableLayer() {
    if (velocityLayer && map.hasLayer(velocityLayer)) {
      map.removeLayer(velocityLayer);
    }
  }

  async function enableLayer() {
    // Daten wurden bereits geladen und Layer existiert -> nur wieder einblenden
    if (velocityLayer) {
      map.addLayer(velocityLayer);
      return;
    }

    try {
      const data = await getWindData();
      if (!data) {
        checkbox.checked = false;
        return;
      }

      velocityLayer = L.velocityLayer({
        data,
        maxVelocity: 25,
        velocityScale: 0.008,
        particleAge: 60,
        particleMultiplier: 0.012,
        frameRate: 20,
        lineWidth: 1.2,
        velocityType: '10m Wind',
        speedUnit: 'm/s'
      });

      map.addLayer(velocityLayer);
    } catch (err) {
      console.error('Windströmung konnte nicht aktiviert werden:', err);
      checkbox.checked = false;
    }
  }

  function getWindData() {
    if (windPayload) return Promise.resolve(windPayload);
    if (loadPromise) return loadPromise;

    loadPromise = fetch('/wind/current.json', { cache: 'no-store' })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
      })
      .then((raw) => {
        const formatted = formatWindData(raw);
        if (!formatted) return null;
        windPayload = formatted; // Cache, damit nicht erneut geladen wird
        return formatted;
      })
      .catch((err) => {
        console.error('Winddaten konnten nicht geladen werden:', err);
        checkbox.checked = false;
        return null;
      })
      .finally(() => {
        loadPromise = null;
      });

    return loadPromise;
  }

  function formatWindData(raw) {
    const bounds = raw?.meta?.bounds;
    const grid = raw?.meta?.grid;
    const refTime = raw?.meta?.datasetTime;
    const u = Array.isArray(raw?.u) ? raw.u : null;
    const v = Array.isArray(raw?.v) ? raw.v : null;

    if (!bounds || !grid || !u || !v) {
      console.error('Winddaten unvollständig oder fehlerhaft.');
      return null;
    }

    const west = Number(bounds.west);
    const east = Number(bounds.east);
    const north = Number(bounds.north);
    const south = Number(bounds.south);
    const dx = Number(grid.longitudeStep);
    const dy = Number(grid.latitudeStep);

    if (![west, east, north, south, dx, dy].every(Number.isFinite) || dx === 0 || dy === 0) {
      console.error('Ungültige Bounds/Grid in den Winddaten.');
      return null;
    }

    // Erwartete Rastergröße aus Bounds ableiten (inklusive Start/Ende)
    const nx = Math.round((east - west) / dx) + 1;
    const ny = Math.round((north - south) / dy) + 1;

    if (nx <= 1 || ny <= 1 || u.length !== nx * ny || v.length !== nx * ny) {
      console.error('Winddaten haben nicht die erwartete Länge.');
      return null;
    }

    const baseHeader = {
      parameterCategory: 2,
      nx,
      ny,
      lo1: west,
      la1: north,
      lo2: east,
      la2: south,
      dx,
      dy,
      refTime: refTime || new Date().toISOString()
    };

    // leaflet-velocity erwartet ein Array aus U- und V-Komponente
    return [
      { header: { ...baseHeader, parameterNumber: 2 }, data: u },
      { header: { ...baseHeader, parameterNumber: 3 }, data: v }
    ];
  }
}
