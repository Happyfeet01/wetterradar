# Logging und Fehlersuche

Das Wetterradar besitzt zwei Diagnoseebenen:

1. **Browser-/Leaflet-Log** unter `/var/log/wetterradar/client.log`
2. **EUMETView-/Satelliten-Proxy-Log** unter `/var/log/nginx/wetter-satellite.access.log`

Das Browser-Logging erfasst unter anderem:

- JavaScript-Fehler und `unhandledrejection`
- fehlgeschlagene Ressourcen (Bilder, Skripte, Styles)
- `console.warn` / `console.error` sowie vorhandene Konsolenmeldungen
- `fetch()`-Requests mit Status, Dauer und ausgewählten Cache-Headern
- Leaflet-Version, Layer add/remove, Kartenbewegungen und Zoom
- Leaflet-Tilefehler und ImageOverlay-Ladevorgänge
- Radar-/Satelliten-Schaltvorgänge und periodische Refreshes

Unbekannte Query-Parameter werden im Browser vor dem Versand geschwärzt. Felder wie Token, Passwort, Cookie oder Authorization werden ebenfalls redigiert. Der lokale Log-Empfänger erhält über Nginx keine Client-IP.

## Installation auf dem Server

Nach dem Deployment des Repository-Stands:

```bash
sudo cp /var/www/wetterradar/etc/systemd/wetterradar-client-log.service /etc/systemd/system/
sudo cp /var/www/wetterradar/etc/logrotate.d/wetterradar-client /etc/logrotate.d/
sudo systemctl daemon-reload
sudo systemctl enable --now wetterradar-client-log.service
```

Die Nginx-Konfiguration muss anschließend aus dem mitgelieferten vHost übernommen bzw. mit der produktiven Konfiguration abgeglichen werden. Danach:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Live ansehen

Browser-/Leaflet-Log:

```bash
sudo tail -f /var/log/wetterradar/client.log
```

Nur Fehler/Warnungen:

```bash
sudo tail -f /var/log/wetterradar/client.log | grep -E '"level":"(warn|error)"'
```

Satelliten-Proxy:

```bash
sudo tail -f /var/log/nginx/wetter-satellite.access.log
```

Für den aktuellen Satellitenfehler sind insbesondere diese Werte interessant:

- `request=GetCapabilities` oder `request=GetMap`
- vorhandener bzw. fehlender `time=`-Parameter
- sich ändernder `_refresh=`-Wert
- `cache=MISS`, `HIT`, `STALE` oder `UPDATING`
- `upstream=200` bzw. Fehlerstatus
- `rt` und `urt` für Request-/Upstream-Dauer

## Rotation

`client.log` wird täglich rotiert und 14 Tage aufbewahrt. Die Nginx-Satellitenlogs laufen über die normale Nginx-Logrotation des Systems.
