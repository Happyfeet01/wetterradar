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

## Windströmungsdaten (`/wind/current.json`)

- **Veröffentlichter Endpunkt:** Das Leaflet-Velocity-Overlay lädt seine Vektordaten aus `https://<host>/wind/current.json`. Im Repo liegt ein synthetisches Platzhalterfeld (`wind/current.json`), damit der Endpunkt auch ohne laufenden Fetcher gültige Metadaten liefert.
- **Fetcher:** `wind-fetcher.js` sampelt das Open-Meteo-GFS (10 m Wind) rasterförmig über Mitteleuropa und schreibt die U/V-Komponenten in das Leaflet-Velocity-Format. Standard: 1°-Raster, Aktualisierung alle 30 min, Requests leicht gedrosselt.
- **Aufruf:**
  - Einmalige Aktualisierung (z. B. via Cron): `npm run wind:once`
  - Dauerschleife mit Intervall (z. B. systemd-Service): `npm run wind:watch`
- **Konfiguration via Umgebungsvariablen:**

  | Variable | Bedeutung | Standard |
  | --- | --- | --- |
  | `WIND_LAT_MAX` / `WIND_LAT_MIN` | Nord-/Südbegrenzung des Gitters (Grad) | `56` / `46` |
  | `WIND_LON_MIN` / `WIND_LON_MAX` | West-/Ostbegrenzung (Grad) | `5` / `16` |
  | `WIND_LAT_STEP` / `WIND_LON_STEP` | Rasterauflösung in Grad | `1` |
  | `WIND_REFRESH_MINUTES` | Aktualisierungsintervall | `30` |
  | `WIND_REQUEST_DELAY_MS` | Pause zwischen Open-Meteo-Requests | `150` |
  | `WIND_API_URL` / `WIND_API_PARAMS` | Alternative API bzw. Parameterliste | Open-Meteo GFS, `wind_speed_10m,wind_direction_10m` |

- **Fehlertoleranz:** Scheitert ein Lauf (z. B. API nicht erreichbar), bleibt die zuletzt erzeugte `current.json` erhalten; Fehler werden im Log ausgegeben.

### Beispiel systemd-Unit (optional)

```ini
[Unit]
Description=Open-Meteo → Leaflet-Velocity Fetcher
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/var/www/wetterradar
Environment="WIND_REFRESH_MINUTES=30"
ExecStart=/usr/bin/node wind-fetcher.js
Restart=always
RestartSec=10
User=www-data

[Install]
WantedBy=multi-user.target
```

> Alternativ kann `npm run wind:once` alle 30 Minuten über Cron gestartet werden.

## Deployment-Hinweise

- Beim Upload/Sync der statischen Seite muss der neue Ordner `wind/` mitgenommen werden (z. B. `rsync -av --delete css js wind index.html …`).
- Auf dem Server sollten Schreibrechte für den Fetcher auf `/var/www/wetterradar/wind/current.json` bestehen.
- Die Beispiel-Nginx-Config (siehe `etc/nginx/sites-available/wetter.domain.tld`) enthält einen Location-Block für `/wind/`, der Caching + CORS-Header setzt.
