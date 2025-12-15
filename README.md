# Wetterradar (Leaflet + RainViewer + NOAA GFS + DWD)

Interaktive Wetterkarte mit Radar- und Satellitenanimation, Wind-Partikelfeld und DWD-Warngebieten (CAP-Polygone). Leichtgewichtig mit Leaflet und Vanilla-JS.

## Features

- **Niederschlagsradar (RainViewer)**
  *Vergangenheit + Nowcast* (kurzfristige Vorhersage), animiert über Time-Slider.
- **IR-Satellitenbilder (RainViewer)**
  Synchronisiert zum Radar-Zeitpunkt; ein-/ausblendbar, Opazität regelbar.
- **Wind-Partikelfeld (leaflet-velocity)**
  Vektorfeld aus **NOAA/NCEP GFS 1.0° (10 m Wind)** via NOMADS-Filter, als animierte Partikel (east/north-Komponenten).
- **DWD-Warnungen**
  Parsing des **CAP-Feeds**: Polygone/Kreise als Leaflet-Overlays, farbcodiert nach Severity; Warnliste in Panel.
- **UI/Controls**
  Layer-Toggles, Opazitäts-Slider, Farbschema, „Smooth“, Play/Pause, Zeitsprung, Legende, Zeitstempel.

## Datenquellen

- **RainViewer Weather Maps API** – Radar/Satellit (Tiles + Frames)
- **NOAA/NCEP GFS via NOMADS** – Windgeschwindigkeit/-richtung (10 m)
- **DWD CAP/JSON** – amtliche Warnungen (Polygone + Metadaten)

> Hinweis zu Limits (Stand 2025): RainViewer Free begrenzt Zoom (≤ 10) und Nowcast-Dauer; IR-Satellit wird von RainViewer mittelfristig eingeschränkt. Prüfe ggf. die aktuellen Nutzungsbedingungen/Docs.

## Verzeichnis­struktur

├─ index.html
├─ css/
├─ js/
│ ├─ app.js # Bootstrapping, Konfiguration, Wiring der Module
│ ├─ map.js # Leaflet-Karte (OSM)
│ ├─ radar.js # RainViewer Radar + Animation/Timeline
│ ├─ clouds.js # IR-Satellit (RainViewer), Zeitsync + Throttle
│ ├─ wind_particles.js # leaflet-velocity + NOAA-GFS-Sampling
│ ├─ warnings.js # DWD JSON-Liste + CAP-Polygone als Overlays
│ └─ utils.js # Helfer (Fetch/Proxy, DOM, Formatierungen, Legend)
├─ etc/nginx/sites-available/ # Beispiel-Nginx-Config (optional)
├─ blitz-proxy.js # Mini-Proxy-Script (optional)
├─ package.json
└─ README.md

## Windströmungsdaten (`/wind/current.json`)

- **Veröffentlichter Endpunkt:** Das Leaflet-Velocity-Overlay lädt seine Vektordaten aus `https://<host>/wind/current.json`. Im Repo liegt ein synthetisches Platzhalterfeld (`wind/current.json`), damit der Endpunkt auch ohne laufenden Fetcher gültige Metadaten liefert.
- **Fetcher:** `tools/noaa-wind-fetcher.js` lädt den jeweils aktuellsten GFS-Analyse-Lauf (10 m Wind, 1.0°-Raster) als GRIB2 via NOMADS-Filter, konvertiert ihn mit `@weacast/grib2json` und schreibt die U/V-Komponenten im Leaflet-Velocity-Format nach `/var/www/wetterradar/wind/current.json` (und bei Erfolg zusätzlich `fallback.json`).
- **Aufruf:**
  - Einmalige Aktualisierung (z. B. manuell oder in CI): `node tools/noaa-wind-fetcher.js`
- **Abhängigkeiten:** Node.js + npm sowie Java-Laufzeit (für `@weacast/grib2json`, z. B. `default-jre-headless`).

### systemd-Service + Timer

Die mitgelieferten Units automatisieren den Abruf zu den offiziellen GFS-Zyklen (00/06/12/18 UTC):

```
systemctl status wetterradar-noaa-wind.timer
```

Installation (als root):

```
cp systemd/wetterradar-noaa-wind.service /etc/systemd/system/
cp systemd/wetterradar-noaa-wind.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wetterradar-noaa-wind.timer
```

## Deployment-Hinweise

- Beim Upload/Sync der statischen Seite muss der neue Ordner `wind/` mitgenommen werden (z. B. `rsync -av --delete css js wind index.html …`).
- Auf dem Server sollten Schreibrechte für den Fetcher auf `/var/www/wetterradar/wind/current.json` bestehen.
- Die Beispiel-Nginx-Config (siehe `etc/nginx/sites-available/wetter.domain.tld`) enthält einen Location-Block für `/wind/`, der Caching + CORS-Header setzt.
