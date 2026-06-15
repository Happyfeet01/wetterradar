import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DWD_SAT_BOUNDS, DWD_SAT_IMAGE, DWD_SAT_LAYER, DWD_SAT_WMS, DWD_SAT_WMS_FALLBACKS } from './config.js';
import { __test } from './satellite.js';

const { buildEndpointList, buildGetMapUrl, getImageConfig, normalizeWmsUrl } = __test;

describe('DWD satellite WMS configuration', () => {
  it('uses the current DWD Meteosat Europe RGB/IR layer', () => {
    assert.equal(DWD_SAT_LAYER, 'dwd:Satellite_meteosat_1km_euat_rgb_day_hrv_and_night_ir108_3h');
  });

  it('tries direct DWD endpoints before the local proxy', () => {
    const endpoints = buildEndpointList(DWD_SAT_WMS, DWD_SAT_WMS_FALLBACKS);

    assert.equal(endpoints[0], 'https://maps.dwd.de/geoserver/dwd/ows?');
    assert.ok(endpoints.includes('https://maps.dwd.de/geoserver/wms?'));
    assert.ok(endpoints.includes('https://brz-maps.dwd.de/geoserver/wms?'));
    assert.equal(endpoints.at(-1), '/dwd/sat/wms?');
    assert.equal(new Set(endpoints).size, endpoints.length);
  });

  it('normalizes WMS URLs to include a query separator', () => {
    assert.equal(normalizeWmsUrl('https://example.test/geoserver/wms'), 'https://example.test/geoserver/wms?');
    assert.equal(normalizeWmsUrl(' https://example.test/geoserver/wms? '), 'https://example.test/geoserver/wms?');
    assert.equal(normalizeWmsUrl(''), null);
  });

  it('builds a fixed EPSG:4326 GetMap URL for the Europe image overlay', () => {
    const url = buildGetMapUrl(DWD_SAT_WMS, 12345);
    const parsed = new URL(url);

    assert.equal(parsed.origin + parsed.pathname + '?', DWD_SAT_WMS);
    assert.equal(parsed.searchParams.get('service'), 'WMS');
    assert.equal(parsed.searchParams.get('version'), '1.1.1');
    assert.equal(parsed.searchParams.get('request'), 'GetMap');
    assert.equal(parsed.searchParams.get('layers'), DWD_SAT_LAYER);
    assert.equal(parsed.searchParams.get('srs'), 'EPSG:4326');
    assert.equal(parsed.searchParams.get('bbox'), '-53.99411012,22.99844049,54.00310988,76.99256049');
    assert.equal(parsed.searchParams.get('width'), String(DWD_SAT_IMAGE.width));
    assert.equal(parsed.searchParams.get('height'), String(DWD_SAT_IMAGE.height));
    assert.equal(parsed.searchParams.get('_t'), '12345');
  });

  it('keeps the image overlay bounds in south-west/north-east Leaflet order', () => {
    const { bounds, width, height } = getImageConfig();

    assert.deepEqual(bounds, DWD_SAT_BOUNDS);
    assert.deepEqual(bounds[0], [22.99844049, -53.99411012]);
    assert.deepEqual(bounds[1], [76.99256049, 54.00310988]);
    assert.equal(width, 1024);
    assert.equal(height, 574);
  });
});
