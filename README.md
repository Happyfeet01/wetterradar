# Wetterradar (Leaflet + RainViewer + Open-Meteo + DWD)

Interaktive Wetterkarte mit Radar- und Satellitenanimation, Wind-Partikelfeld und DWD-Warngebieten (CAP-Polygone). Leichtgewichtig mit Leaflet und Vanilla-JS.

## Features

- **Niederschlagsradar (RainViewer)**  
  *Vergangenheit + Nowcast* (kurzfristige Vorhersage), animiert über Time-Slider.
- **IR-Satellitenbilder (RainViewer)**  
  Synchronisiert zum Radar-Zeitpunkt; ein-/ausblendbar, Opazität regelbar.
- **Wind-Partikelfeld (leaflet-velocity)**  
  Vektorfeld aus Open-Meteo (10 m Wind), als animierte Partikel (east/north-Komponenten).
- **DWD-Warnungen**  
  Parsing des **CAP-Feeds**: Polygone/Kreise als Leaflet-Overlays, farbcodiert nach Severity; Warnliste in Panel.
- **UI/Controls**  
  Layer-Toggles, Opazitäts-Slider, Farbschema, „Smooth“, Play/Pause, Zeitsprung, Legende, Zeitstempel.

## Datenquellen

- **RainViewer Weather Maps API** – Radar/Satellit (Tiles + Frames)  
- **Open-Meteo API** – Windgeschwindigkeit/-richtung (10 m)  
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
│ ├─ wind_particles.js # leaflet-velocity + Open-Meteo-Sampling
│ ├─ warnings.js # DWD JSON-Liste + CAP-Polygone als Overlays
│ └─ utils.js # Helfer (Fetch/Proxy, DOM, Formatierungen, Legend)
├─ etc/nginx/sites-available/ # Beispiel-Nginx-Config (optional)
├─ blitz-proxy.js # Mini-Proxy-Script (optional)
├─ package.json
└─ README.md
