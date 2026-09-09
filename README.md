# Wetterradar

Leichtgewichtige Wetterkarte mit Leaflet und Vanilla-JS. Die öffentliche Instanz läuft unter https://wetter.larsmueller.net.

## Funktionen

- **Niederschlagsradar:** RainViewer-Past-Frames, animierbar über Vor/Zurück und Play. RainViewer bietet im verwendeten Free-Tier keinen Nowcast mehr.
- **Satellit:** EUMETSAT / EUMETView, Layer `mtg_fd:rgb_geocolour`. Die verfügbaren WMS-Zeitpunkte werden per `GetCapabilities` ermittelt und mit der Radar-Zeitachse synchronisiert.
- **Windströmung:** animiertes 10-m-Windfeld mit `leaflet-velocity`. Das Frontend lädt `/wind/current.json`, schneidet das Feld auf den Kartenausschnitt zu und revalidiert aktive Winddaten alle 15 Minuten.
- **Warnungen:** DWD sowie BBK/NINA.
- **Pegelstände:** PEGELONLINE / WSV.
- **Standort:** Geolokalisierung plus aktuelle Windinformation von Open-Meteo.
- **Darstellung:** helle/dunkle Grundkarte, Radar- und Satelliten-Deckkraft, Zeitsteuerung.

## Datenquellen

- RainViewer Weather Maps API – Niederschlagsradar
- EUMETSAT EUMETView – Satellitenbild
- NOAA/NCEP GFS via NOMADS – serverseitig erzeugtes Wind-Vektorfeld
- Open-Meteo – punktuelle Windinformation am gewählten Standort
- DWD – amtliche Wetterwarnungen
- BBK/NINA – Bevölkerungsschutz-Warnungen
- PEGELONLINE / WSV – Pegelstände
- OpenStreetMap – Basiskarte

## Satelliten-Layer

Das Frontend verwendet den EUMETView-WMS über den Same-Origin-Proxy `/eumetview/wms`. Der aktuelle Layer ist:

```text
mtg_fd:rgb_geocolour
```

`js/satellite.js` hält Satellitenframes einheitlich als Objekte mit Unix-Zeit und ISO-Zeit. Damit kann ein RainViewer-Radarframe dem zeitlich nächsten verfügbaren Satellitenbild zugeordnet werden.

Der Satelliten-Layer wird lazy geladen. Ist er eingeschaltet, werden die verfügbaren EUMetView-Zeitpunkte während einer längeren Sitzung regelmäßig neu ermittelt.

## Windströmung

### Frontend

`js/windflow.js` lädt zuerst:

```text
/wind/current.json
```

und verwendet bei einem Fehler:

```text
/wind/fallback.json
```

Während der Layer aktiv ist, wird `current.json` alle 15 Minuten revalidiert. Der laufende Partikelfilm wird nur bei einem neuen Dataset oder einem geänderten Kartenausschnitt aktualisiert. Dafür wird – sofern verfügbar – `leaflet-velocity#setData()` verwendet, statt den kompletten Layer ständig zu entfernen und neu zu erzeugen.

Der angezeigte Zeitstempel stammt aus `meta.datasetTime`, also aus dem tatsächlichen Modellzeitpunkt und nicht nur aus dem Zeitpunkt, zu dem die JSON-Datei geschrieben wurde.

### Server: NOAA/NCEP GFS

Der kanonische Fetcher ist:

```bash
node tools/noaa-wind-fetcher.js
```

oder über npm:

```bash
npm run wind:once
```

Er lädt 10-m-U/V-Wind aus dem NOAA/NCEP-GFS-1°-Raster über NOMADS, konvertiert GRIB2 mit `@weacast/grib2json` und schreibt atomar:

```text
/var/www/wetterradar/wind/current.json
/var/www/wetterradar/wind/fallback.json
```

Benötigt werden Node.js, die npm-Abhängigkeiten und eine Java-Laufzeit für `grib2json`.

### systemd

```bash
sudo mkdir -p /var/lib/wetterradar/noaa-wind /var/www/wetterradar/wind
sudo chown -R www-data:www-data /var/lib/wetterradar /var/www/wetterradar/wind

sudo cp systemd/wetterradar-noaa-wind.service /etc/systemd/system/
sudo cp systemd/wetterradar-noaa-wind.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wetterradar-noaa-wind.timer
```

Der Timer arbeitet ausdrücklich in **UTC**. Die GFS-Läufe haben die Zyklen 00/06/12/18 UTC; der Abruf erfolgt erst einige Stunden später und wird einmal wiederholt, damit ein noch nicht vollständig veröffentlichter NOMADS-Lauf nicht dazu führt, dass sechs Stunden lang ein alter Datensatz stehen bleibt.

Status prüfen:

```bash
systemctl status wetterradar-noaa-wind.timer
systemctl list-timers wetterradar-noaa-wind.timer
journalctl -u wetterradar-noaa-wind.service -n 100 --no-pager
jq '.meta.datasetTime,.meta.updatedAt,.meta.source,.meta.grid' /var/www/wetterradar/wind/current.json
```

Die älteren Dateien `wind-fetcher.js`, `wind-fetcher-consistent.js` und Units unter `etc/systemd/system/` stammen aus früheren Open-Meteo-Varianten. Für neue Installationen ist ausschließlich `tools/noaa-wind-fetcher.js` plus `systemd/wetterradar-noaa-wind.*` vorgesehen.

## Nginx

Eine Beispielkonfiguration liegt unter:

```text
etc/nginx/sites-available/wetter.domain.tld
```

Wichtige lokale Endpunkte:

- `/rainviewer/weather-maps.json` – Same-Origin-Proxy für RainViewer-Metadaten
- `/eumetview/wms` – Same-Origin-Proxy für EUMETView
- `/wind/current.json` und `/wind/fallback.json` – statische Winddaten
- `/dwd/warnings.json` – DWD-Warnungen
- `/nina/` – NINA/BBK-Proxy

Für `/wind/` ist ein kurzer Browsercache sinnvoll; das Frontend revalidiert die Datei und lädt sie nicht blind bei jeder Kartenbewegung neu.

## Tests

```bash
npm test
```

Die Tests decken unter anderem Radar-Laden, EUMETView-Zeitachsen, Wind-Cropping, Dataset-Versionen und Request-Timeouts ab. GitHub Actions führt die Tests bei Pull Requests und auf `fix/**`-Branches aus.

## Unterstützung

Kaffeekasse: https://www.paypal.me/LarsM1980

Liberapay: https://de.liberapay.com/Esmuellerthier/
