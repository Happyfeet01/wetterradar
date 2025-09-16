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

