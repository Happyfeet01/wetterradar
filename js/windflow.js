const WIND_DATA_URL = '/wind/current.json';
const WIND_PANE_NAME = 'windPane';

let velocityLayer = null;
let loadPromise = null;
let checkboxUpdating = false;

function ensurePane(map) {
  if (!map.getPane(WIND_PANE_NAME)) {
    map.createPane(WIND_PANE_NAME);
    const pane = map.getPane(WIND_PANE_NAME);
    if (pane) {
      pane.style.zIndex = '480';
    }
  }
}

async function fetchWindData() {
  const response = await fetch(WIND_DATA_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function validateEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    console.error(`Windströmung: Eintrag ${index} ist ungültig.`);
    return false;
  }
  const header = entry.header;
  const nx = header?.nx;
  const ny = header?.ny;
  if (!Number.isInteger(nx) || nx <= 0 || !Number.isInteger(ny) || ny <= 0) {
    console.error(`Windströmung: Header von Eintrag ${index} enthält ungültige Dimensionen.`);
    return false;
  }
  const values = entry.data;
  const hasArrayBuffer = typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function';
  const isArrayLike = Array.isArray(values) || (hasArrayBuffer && ArrayBuffer.isView(values));
  const length = isArrayLike ? values.length : 0;
  if (!isArrayLike || length !== nx * ny) {
    console.error(`Windströmung: Datenlänge in Eintrag ${index} entspricht nicht nx*ny.`);
    return false;
  }
  return true;
}

function normalizePayload(raw) {
  const dataset = Array.isArray(raw?.data)
    ? raw.data
    : Array.isArray(raw)
      ? raw
      : null;

  if (!Array.isArray(dataset)) {
    console.error('Windströmung: Unerwartetes Datenformat.');
    return null;
  }

  if (dataset.length < 2) {
    console.error('Windströmung: Datensatz enthält weniger als zwei Komponenten.');
    return null;
  }

  for (let i = 0; i < dataset.length; i += 1) {
    if (!validateEntry(dataset[i], i)) {
      return null;
    }
  }

  if (Array.isArray(raw?.data) && raw && typeof raw === 'object') {
    return { ...raw, data: dataset };
  }

  return { data: dataset };
}

function createVelocityLayer(L, payload) {
  if (typeof L.velocityLayer !== 'function') {
    console.error('Windströmung: leaflet-velocity ist nicht verfügbar.');
    return null;
  }

  return L.velocityLayer({
    data: payload,
    pane: WIND_PANE_NAME,
    maxVelocity: 25,
    velocityScale: 0.008,
    particleAge: 60,
    particleMultiplier: 0.012,
    lineWidth: 1.2,
    frameRate: 20,
    displayValues: true,
    displayOptions: {
      velocityType: '10m Wind',
      position: 'bottomleft',
      speedUnit: 'm/s',
    },
  });
}

async function ensureLayer(L, map) {
  if (velocityLayer) {
    return velocityLayer;
  }

  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fetchWindData();
        const payload = normalizePayload(raw);
        if (!payload) {
          return null;
        }
        ensurePane(map);
        velocityLayer = createVelocityLayer(L, payload);
        return velocityLayer;
      } catch (error) {
        throw error;
      }
    })().finally(() => {
      loadPromise = null;
    });
  }

  return loadPromise;
}

function setCheckboxChecked(checkbox, checked) {
  if (!checkbox) {
    return;
  }
  checkboxUpdating = true;
  checkbox.checked = checked;
  checkboxUpdating = false;
}

function removeLayer(map) {
  if (velocityLayer && map.hasLayer(velocityLayer)) {
    map.removeLayer(velocityLayer);
  }
}

export function bindWindFlow(L, map, ui) {
  const checkbox = ui?.chkWindFlow;
  if (!checkbox) {
    return;
  }

  const hintElement = checkbox.closest('.row')?.querySelector('.hint');
  const originalHint = hintElement?.textContent ?? '';

  const setHint = (text) => {
    if (hintElement) {
      hintElement.textContent = text;
    }
  };

  checkbox.addEventListener('change', async () => {
    if (checkboxUpdating) {
      return;
    }

    if (!checkbox.checked) {
      removeLayer(map);
      setHint(originalHint);
      return;
    }

    checkbox.disabled = true;
    setHint('lädt…');
    try {
      const layer = await ensureLayer(L, map);
      if (!layer) {
        console.error('Windströmung: Ungültige Daten erhalten.');
        removeLayer(map);
        setCheckboxChecked(checkbox, false);
        return;
      }
      if (!map.hasLayer(layer)) {
        layer.addTo(map);
      }
      setHint(originalHint);
    } catch (error) {
      console.error('Windströmung konnte nicht geladen werden:', error);
      removeLayer(map);
      setCheckboxChecked(checkbox, false);
    } finally {
      checkbox.disabled = false;
      if (!checkbox.checked) {
        setHint(originalHint);
      }
    }
  });
}
