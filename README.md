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
- **Blitzortung-Livefeed (SSE)**
  Echtzeit-Blitzereignisse via Server-Sent Events; Anzeige als Marker mit Counter im Kartenausschnitt.
- **UI/Controls**
  Layer-Toggles, Opazitäts-Slider, Farbschema, „Smooth“, Play/Pause, Zeitsprung, Legende, Zeitstempel.

## Datenquellen

- **RainViewer Weather Maps API** – Radar/Satellit (Tiles + Frames)
- **Open-Meteo API** – Windgeschwindigkeit/-richtung (10 m)
- **DWD CAP/JSON** – amtliche Warnungen (Polygone + Metadaten)
- **Blitzortung.org** – Live-Blitzmeldungen (via eigener SSE-Bridge)

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
- **Fetcher:** `wind-fetcher.js` sampelt das Open-Meteo-GFS (10 m Wind) rasterförmig über Europa (Standard) und schreibt die U/V-Komponenten in das Leaflet-Velocity-Format. Standard: 1°-Raster, Aktualisierung alle 30 min, Requests leicht gedrosselt.
- **Standard-Ausschnitt:** Europa ist nun der Default (siehe Tabelle). Globaler Abruf ist möglich, aber eher ein Nice-to-have und bedarf ggf. groberem Raster.
- **Aufruf:**
  - Einmalige Aktualisierung (z. B. via Cron): `npm run wind:once`
  - Dauerschleife mit Intervall (z. B. systemd-Service): `npm run wind:watch`
- **Konfiguration via Umgebungsvariablen:**

  | Variable | Bedeutung | Standard |
  | --- | --- | --- |
  | `WIND_LAT_MAX` / `WIND_LAT_MIN` | Nord-/Südbegrenzung des Gitters (Grad) | `72` / `34` |
  | `WIND_LON_MIN` / `WIND_LON_MAX` | West-/Ostbegrenzung (Grad) | `-25` / `45` |
  | `WIND_LAT_STEP` / `WIND_LON_STEP` | Rasterauflösung in Grad | `1` |
  | `WIND_REFRESH_MINUTES` | Aktualisierungsintervall | `30` |
  | `WIND_REQUEST_DELAY_MS` | Pause zwischen Open-Meteo-Requests | `150` |
  | `WIND_API_URL` / `WIND_API_PARAMS` | Alternative API bzw. Parameterliste | Open-Meteo GFS, `wind_speed_10m,wind_direction_10m` |

- **Ausschnitt anpassen (Beispiele):** Die Grenzen steuern, welche Region gesampelt wird. Größere Ausschnitte bzw. feinere Raster bedeuten mehr Einzel-Requests (≈ `nx * ny`).

  | Region | Grenzen setzen | Hinweis |
  | --- | --- | --- |
  | **Europa** | `WIND_LAT_MAX=72`, `WIND_LAT_MIN=34`, `WIND_LON_MIN=-25`, `WIND_LON_MAX=45` | Schrittweite bei `1` lassen, damit die Laufzeit moderat bleibt. |
  | **Global** | `WIND_LAT_MAX=90`, `WIND_LAT_MIN=-90`, `WIND_LON_MIN=-180`, `WIND_LON_MAX=180` | Rasterweite ggf. auf `2–5` Grad erhöhen, sonst wird der Durchlauf sehr lang. |

- **Aufruf mit angepasstem Ausschnitt:**

  ```bash
  # Einmaliger Lauf nur für Europa (Beispiel)
  WIND_LAT_MAX=72 WIND_LAT_MIN=34 \
  WIND_LON_MIN=-25 WIND_LON_MAX=45 \
  npm run wind:once

  # Endlosschleife mit globalem Raster (luftigeres Grid)
  WIND_LAT_MAX=90 WIND_LAT_MIN=-90 \
  WIND_LON_MIN=-180 WIND_LON_MAX=180 \
  WIND_LAT_STEP=3 WIND_LON_STEP=3 \
  npm run wind:watch
  ```

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

## Live-Blitze via Blitzortung (optional)

- **Zweck:** Echtzeit-Blitzereignisse aus der Blitzortung-Community als SSE-Stream einblenden. Das Frontend lauscht standardmäßig auf `/blitze` (konfigurierbar in `js/config.js`).
- **Bridge-Server:** `blitz-proxy.js` startet einen kleinen Express-Server mit SSE-Endpunkt, der die Blitzortung-Daten aus `@simonschick/blitzortungapi` weiterreicht und die letzten 10 Minuten puffert.
- **Start (lokal oder als Dienst):**

  ```bash
  # Abhängigkeiten sind bereits in package.json enthalten
  node blitz-proxy.js
  # → lauscht auf http://localhost:9024/blitze (SSE)
  ```

- **Frontend anbinden:**
  - Läuft die Seite auf demselben Host/Port, reicht der Default `/blitze`.
  - Bei abweichendem Port/Host im Frontend `SSE_LIGHTNING` (in `js/config.js`) auf die volle URL setzen, z. B. `http://localhost:9024/blitze`.
- **Sicherheit/Hinweise:** Der SSE-Endpoint wird mit `cors()` freigegeben. Bei produktivem Einsatz ggf. die erlaubten Origins einschränken und den Dienst hinter einen Reverse-Proxy (https) hängen.

## Deployment-Hinweise

- Beim Upload/Sync der statischen Seite muss der neue Ordner `wind/` mitgenommen werden (z. B. `rsync -av --delete css js wind index.html …`).
- Auf dem Server sollten Schreibrechte für den Fetcher auf `/var/www/wetterradar/wind/current.json` bestehen.
- Die Beispiel-Nginx-Config (siehe `etc/nginx/sites-available/wetter.domain.tld`) enthält einen Location-Block für `/wind/`, der Caching + CORS-Header setzt.

## NINA/BBK-Warnungen automatisiert aktualisieren

- **Fetcher:** `nina-fetcher.js` lädt die aktiven NINA/BBK-Warnungen pro Regionalschlüssel, holt für jede Warnung die GeoJSON-Geometrien ab und bündelt alles als `warnings/nina.geojson` (FeatureCollection) im Webroot. Die API-Basis lässt sich via `NINA_API_BASE` überschreiben (Default: `https://nina.api.proxy.bund.dev/api31`).
  - Regionalschlüssel stammen aus `Regionalschluessel_2021-07-31.json` (lokal oder per Fallback-Download). Alternativ lässt sich die Datei über `NINA_ARS_FILE` angeben.
- **systemd-Units im Repo:**
  - `nina-fetcher.service` – einmaliger Lauf (oneshot), führt `node nina-fetcher.js` im Projektverzeichnis aus.
  - `nina-fetcher.timer` – startet den Service alle 5 Minuten (`OnCalendar=*:0/5`, `Persistent=true`).
- **Einrichtung (Beispiel /var/www/wetterradar):**

  ```bash
  # Dateien nach /etc/systemd/system kopieren (Pfad/User bei Bedarf anpassen)
  sudo cp nina-fetcher.service nina-fetcher.timer /etc/systemd/system/

  sudo systemctl daemon-reload

  # Timer aktivieren und sofort starten
  sudo systemctl enable --now nina-fetcher.timer

  # Ad-hoc-Lauf, falls sofortige Aktualisierung gewünscht
  sudo systemctl start nina-fetcher.service
  ```

- **Pfad/User anpassen:** In `nina-fetcher.service` `WorkingDirectory`, `User` und ggf. `ExecStart` (Pfad zu Node.js) auf die lokale Installation abstimmen.
- **Status/Logs prüfen:** `systemctl status nina-fetcher.timer` bzw. `journalctl -u nina-fetcher.service -e` zeigt, ob die Fetches erfolgreich laufen.
