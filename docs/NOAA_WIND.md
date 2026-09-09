# NOAA/NCEP GFS wind pipeline

This backend pipeline downloads 10 m wind from the NOAA/NCEP GFS 1.0° grid via the NOMADS GRIB2 filter and converts it to the Leaflet-velocity JSON format used by the frontend.

## Prerequisites

- Java runtime for `@weacast/grib2json` (`default-jre-headless` on Debian/Ubuntu)
- Node.js and the repository dependencies

On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y default-jre-headless
cd /var/www/wetterradar
npm install
```

`@weacast/grib2json` requires Java. The fetcher automatically uses `/usr/lib/jvm/default-java` when `JAVA_HOME` is not already set; the supplied systemd unit also sets this path explicitly.

## Deployment

```bash
sudo mkdir -p /var/lib/wetterradar/noaa-wind /var/www/wetterradar/wind
sudo chown -R www-data:www-data /var/lib/wetterradar /var/www/wetterradar/wind

sudo cp systemd/wetterradar-noaa-wind.service systemd/wetterradar-noaa-wind.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wetterradar-noaa-wind.timer
```

The timer is defined in UTC. GFS cycles are 00/06/12/18 UTC, but FH000 is not necessarily available at the nominal cycle time. The supplied timer therefore checks later and retries one hour afterwards instead of polling exactly at 00/06/12/18.

## Manual update

```bash
sudo -u www-data node /var/www/wetterradar/tools/noaa-wind-fetcher.js
```

or:

```bash
npm run wind:once
```

## Verification

```bash
systemctl list-timers wetterradar-noaa-wind.timer
journalctl -u wetterradar-noaa-wind.service -n 100 --no-pager
jq '.meta.datasetTime,.meta.updatedAt,.meta.source,.meta.grid,(.data|length)' /var/www/wetterradar/wind/current.json
curl -I https://wetter.larsmueller.net/wind/current.json
```

The browser-side wind layer revalidates `current.json` every 15 minutes while enabled. A new particle field is applied only when the model dataset changes; failed refreshes keep the last valid animation visible.
