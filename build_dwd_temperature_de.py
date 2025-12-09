#!/usr/bin/env python3
"""
Example cron: update German temperatures every hour
5 * * * * /usr/bin/python3 /path/to/build_dwd_temperature_de.py

Builds JSON outputs for German temperatures based solely on DWD station data.
The script expects locally available DWD raw files (no HTTP download here):
- Station metadata in ./dwd_raw/stations.csv (semicolon/CSV/TSV tolerated)
- Hourly temperature files per station in ./dwd_raw/temperatures/{STATION_ID}.csv

Generated files (atomic writes):
- ./public/data/temperature-germany-grid.json
- ./public/data/temperature-germany-cities.json
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import logging
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

RAW_DIR = Path(__file__).resolve().parent / "dwd_raw"
STATION_FILE = RAW_DIR / "stations.csv"
TEMPERATURE_DIR = RAW_DIR / "temperatures"
OUTPUT_DIRS = [
    Path(__file__).resolve().parent / "public" / "data",
    Path(__file__).resolve().parent / "data",  # compatibility with existing static setup
]
GRID_LAT_RANGE = (47.0, 55.0)
GRID_LON_RANGE = (5.5, 15.5)
GRID_STEP = 0.25
BUCKET_SIZE_DEG = 0.5
MAX_BUCKET_RADIUS = 4  # degrees to expand when searching buckets

GERMAN_CITIES = [
    {"name": "Berlin", "lat": 52.5200, "lon": 13.4050},
    {"name": "Hamburg", "lat": 53.5511, "lon": 9.9937},
    {"name": "München", "lat": 48.1351, "lon": 11.5820},
    {"name": "Köln", "lat": 50.9375, "lon": 6.9603},
    {"name": "Frankfurt am Main", "lat": 50.1109, "lon": 8.6821},
    {"name": "Stuttgart", "lat": 48.7758, "lon": 9.1829},
    {"name": "Leipzig", "lat": 51.3397, "lon": 12.3731},
    {"name": "Dresden", "lat": 51.0504, "lon": 13.7373},
    {"name": "Hannover", "lat": 52.3759, "lon": 9.7320},
    {"name": "Nürnberg", "lat": 49.4521, "lon": 11.0767},
    {"name": "Bremen", "lat": 53.0793, "lon": 8.8017},
    {"name": "Essen", "lat": 51.4556, "lon": 7.0116},
    {"name": "Dortmund", "lat": 51.5136, "lon": 7.4653},
    {"name": "Duisburg", "lat": 51.4344, "lon": 6.7623},
    {"name": "Bochum", "lat": 51.4818, "lon": 7.2162},
    {"name": "Wuppertal", "lat": 51.2562, "lon": 7.1508},
    {"name": "Bonn", "lat": 50.7374, "lon": 7.0982},
    {"name": "Karlsruhe", "lat": 49.0069, "lon": 8.4037},
]


def _sniff_dialect(path: Path) -> csv.Dialect:
    sample = path.read_text(encoding="utf-8", errors="ignore")[:2048]
    try:
        return csv.Sniffer().sniff(sample)
    except csv.Error:
        dialect = csv.get_dialect("excel")
        dialect.delimiter = ";"
        return dialect


def _parse_float(value: str) -> Optional[float]:
    try:
        num = float(value)
    except (ValueError, TypeError):
        return None
    if math.isnan(num):
        return None
    return num


def _parse_timestamp(value: str) -> Optional[dt.datetime]:
    if not value:
        return None
    value = value.strip()
    # Common DWD: yyyymmddHH (UTC)
    if value.isdigit() and len(value) in (10, 12):
        try:
            fmt = "%Y%m%d%H" if len(value) == 10 else "%Y%m%d%H%M"
            return dt.datetime.strptime(value, fmt).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            pass
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return dt.datetime.strptime(value, fmt).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
    try:
        # Python 3.11 accepts timezone in fromisoformat if present
        return dt.datetime.fromisoformat(value).astimezone(dt.timezone.utc)
    except ValueError:
        return None


@dataclass
class Station:
    id: str
    name: str
    lat: float
    lon: float
    temp: Optional[float] = None
    timestamp: Optional[str] = None  # ISO8601 UTC


class SpatialIndex:
    def __init__(self, stations: Iterable[Station], bucket_size: float = BUCKET_SIZE_DEG):
        self.bucket_size = bucket_size
        self.buckets: Dict[Tuple[int, int], List[Station]] = {}
        self._all: List[Station] = []
        for st in stations:
            self._all.append(st)
            key = self._bucket(st.lat, st.lon)
            self.buckets.setdefault(key, []).append(st)

    def _bucket(self, lat: float, lon: float) -> Tuple[int, int]:
        return (int(lat / self.bucket_size), int(lon / self.bucket_size))

    def _neighbor_cells(self, lat: float, lon: float, radius: int) -> List[Tuple[int, int]]:
        base = self._bucket(lat, lon)
        cells = []
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                cells.append((base[0] + dx, base[1] + dy))
        return cells

    def nearest(self, lat: float, lon: float) -> Optional[Tuple[Station, float]]:
        best: Optional[Tuple[Station, float]] = None
        for radius in range(0, MAX_BUCKET_RADIUS + 1):
            candidates: List[Station] = []
            for cell in self._neighbor_cells(lat, lon, radius):
                candidates.extend(self.buckets.get(cell, []))
            if not candidates and radius < MAX_BUCKET_RADIUS:
                continue
            for st in candidates:
                dist = haversine_km(lat, lon, st.lat, st.lon)
                if best is None or dist < best[1]:
                    best = (st, dist)
            if best:
                return best
        # Fallback to brute-force
        for st in self._all:
            dist = haversine_km(lat, lon, st.lat, st.lon)
            if best is None or dist < best[1]:
                best = (st, dist)
        return best


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def load_stations(path: Path = STATION_FILE) -> List[Station]:
    if not path.exists():
        logging.warning("Station file not found: %s", path)
        return []
    dialect = _sniff_dialect(path)
    stations: List[Station] = []
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        reader = csv.DictReader(f, dialect=dialect)
        for row in reader:
            station_id = row.get("id") or row.get("station_id") or row.get("STATION_ID") or row.get("Stations_id")
            name = row.get("name") or row.get("NAME") or row.get("Ort") or row.get("station")
            lat_raw = row.get("lat") or row.get("latitude") or row.get("geoBreite") or row.get("gkz_lat")
            lon_raw = row.get("lon") or row.get("longitude") or row.get("geoLaenge") or row.get("gkz_lon")
            lat = _parse_float(lat_raw)
            lon = _parse_float(lon_raw)
            if not station_id or lat is None or lon is None:
                logging.debug("Skipping incomplete station row: %s", row)
                continue
            stations.append(Station(id=str(station_id).strip(), name=(name or str(station_id)).strip(), lat=lat, lon=lon))
    logging.info("Loaded %d stations", len(stations))
    return stations


def _temperature_columns(row: Dict[str, str]) -> Tuple[Optional[str], Optional[str]]:
    ts = row.get("timestamp") or row.get("time") or row.get("datetime") or row.get("MESS_DATUM")
    temp = row.get("temp") or row.get("temperature") or row.get("TT_TU") or row.get("air_temperature")
    return ts, temp


def parse_temperature_file(path: Path) -> Optional[Tuple[float, str]]:
    if not path.exists():
        return None
    dialect = _sniff_dialect(path)
    latest: Optional[Tuple[float, dt.datetime]] = None
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        reader = csv.reader(f, dialect=dialect)
        rows = list(reader)
    if not rows:
        return None
    has_header = any(ch.isalpha() for ch in "".join(rows[0]))
    if has_header:
        dict_reader = csv.DictReader([",".join(rows[0])] + [",".join(r) for r in rows[1:]])
        iterable = list(dict_reader)
    else:
        iterable = [{"timestamp": r[0] if len(r) > 0 else None, "temp": r[1] if len(r) > 1 else None} for r in rows]
    for row in iterable:
        ts_raw, temp_raw = _temperature_columns(row)
        ts = _parse_timestamp(ts_raw or "")
        temp = _parse_float(temp_raw)
        if ts is None or temp is None:
            continue
        if latest is None or ts > latest[1]:
            latest = (temp, ts)
    if latest is None:
        return None
    temp, ts = latest
    return temp, ts.replace(tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z")


def load_latest_temperatures(stations: List[Station], temperature_dir: Path = TEMPERATURE_DIR) -> None:
    if not temperature_dir.exists():
        logging.warning("Temperature directory not found: %s", temperature_dir)
        return
    for st in stations:
        candidate_files = [temperature_dir / f"{st.id}.csv", temperature_dir / f"{st.id}.txt"]
        chosen = next((p for p in candidate_files if p.exists()), None)
        if not chosen:
            logging.debug("No temperature file for station %s", st.id)
            continue
        parsed = parse_temperature_file(chosen)
        if not parsed:
            logging.debug("Could not parse temperature for station %s", st.id)
            continue
        st.temp, st.timestamp = parsed
    valid = sum(1 for s in stations if s.temp is not None)
    logging.info("Attached latest temperature to %d/%d stations", valid, len(stations))


def build_spatial_index(stations: List[Station]) -> SpatialIndex:
    valid = [s for s in stations if s.temp is not None]
    if not valid:
        logging.error("No stations with valid temperature data available")
    return SpatialIndex(valid)


def nearest_station(index: SpatialIndex, lat: float, lon: float) -> Optional[Station]:
    result = index.nearest(lat, lon)
    return result[0] if result else None


def frange(start: float, stop: float, step: float) -> Iterable[float]:
    val = start
    while val <= stop + 1e-9:
        yield round(val, 6)
        val += step


def build_germany_grid(index: SpatialIndex) -> List[Dict[str, object]]:
    points: List[Dict[str, object]] = []
    for lat in frange(GRID_LAT_RANGE[0], GRID_LAT_RANGE[1], GRID_STEP):
        for lon in frange(GRID_LON_RANGE[0], GRID_LON_RANGE[1], GRID_STEP):
            nearest = nearest_station(index, lat, lon)
            if not nearest:
                continue
            points.append(
                {
                    "lat": lat,
                    "lon": lon,
                    "temp": nearest.temp,
                    "station_id": nearest.id,
                    "station_name": nearest.name,
                }
            )
    logging.info("Built grid with %d points", len(points))
    return points


def build_city_list(index: SpatialIndex) -> List[Dict[str, object]]:
    cities: List[Dict[str, object]] = []
    for city in GERMAN_CITIES:
        nearest = nearest_station(index, city["lat"], city["lon"])
        if not nearest:
            logging.debug("No station found near %s", city["name"])
            continue
        cities.append(
            {
                "name": city["name"],
                "lat": city["lat"],
                "lon": city["lon"],
                "temp": nearest.temp,
                "station_id": nearest.id,
                "station_name": nearest.name,
            }
        )
    logging.info("Prepared %d city entries", len(cities))
    return cities


def atomic_write_json(path: Path, payload: Dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp_path, path)
    logging.info("Wrote %s", path)


def write_json_files(grid: List[Dict[str, object]], cities: List[Dict[str, object]]) -> None:
    now_iso = dt.datetime.utcnow().replace(tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z")
    grid_payload = {
        "generated": now_iso,
        "source": "DWD / German Weather Service (station data, interpolated via nearest neighbor)",
        "points": grid,
    }
    city_payload = {
        "generated": now_iso,
        "source": "DWD / German Weather Service (nearest station)",
        "cities": cities,
    }
    for base in OUTPUT_DIRS:
        atomic_write_json(base / "temperature-germany-grid.json", grid_payload)
        atomic_write_json(base / "temperature-germany-cities.json", city_payload)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    stations = load_stations()
    if not stations:
        logging.error("No stations loaded; aborting")
        return
    load_latest_temperatures(stations)
    stations_with_temp = [s for s in stations if s.temp is not None]
    if not stations_with_temp:
        logging.error("No valid temperature readings; aborting")
        return
    index = build_spatial_index(stations_with_temp)
    grid = build_germany_grid(index)
    cities = build_city_list(index)
    if not grid:
        logging.error("Grid generation failed; aborting write")
        return
    write_json_files(grid, cities)


if __name__ == "__main__":
    main()
