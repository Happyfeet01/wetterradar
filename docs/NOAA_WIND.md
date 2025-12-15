# NOAA/NCEP GFS wind pipeline

This backend pipeline downloads 10 m wind from the NOAA/NCEP GFS 1.0° grid via the NOMADS GRIB2 filter and converts it to the Leaflet-velocity JSON format used by the frontend.

## Prerequisites
- Java runtime for `@weacast/grib2json` (`default-jre-headless` on Debian/Ubuntu).
- Node dependencies: `npm install` (adds `@weacast/grib2json`).

## Deployment steps
1. Copy the systemd unit files:
   ```bash
   sudo cp systemd/wetterradar-noaa-wind.service systemd/wetterradar-noaa-wind.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now wetterradar-noaa-wind.timer
   ```
2. Ensure writable paths exist for the service:
   ```bash
   sudo mkdir -p /var/lib/wetterradar/noaa-wind /var/www/wetterradar/wind
   sudo chown -R www-data:www-data /var/lib/wetterradar /var/www/wetterradar/wind
   ```

## Manual run
```bash
sudo -u www-data node /var/www/wetterradar/tools/noaa-wind-fetcher.js
```

## Verification
Inspect the generated metadata and record count:
```bash
jq '.meta.source,.meta.updatedAt,.meta.grid,(.data|length)' /var/www/wetterradar/wind/current.json
```

Check HTTP delivery through nginx:
```bash
curl -I https://wetter.larsmueller.net/wind/current.json
```
