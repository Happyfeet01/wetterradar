import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DWD_SAT_LAYER, DWD_SAT_WMS, DWD_SAT_WMS_FALLBACKS } from './config.js';
import { __test } from './satellite.js';

const { buildEndpointList, normalizeWmsUrl } = __test;

describe('DWD satellite WMS configuration', () => {
  it('uses the current DWD Meteosat Europe RGB/IR layer', () => {
    assert.equal(DWD_SAT_LAYER, 'dwd:Satellite_meteosat_1km_euat_rgb_day_hrv_and_night_ir108_3h');
  });

  it('keeps a local proxy first and direct DWD hosts as fallbacks', () => {
    const endpoints = buildEndpointList(DWD_SAT_WMS, DWD_SAT_WMS_FALLBACKS);

    assert.equal(endpoints[0], '/dwd/sat/wms?');
    assert.ok(endpoints.includes('https://maps.dwd.de/geoserver/wms?'));
    assert.ok(endpoints.includes('https://brz-maps.dwd.de/geoserver/wms?'));
    assert.equal(new Set(endpoints).size, endpoints.length);
  });

  it('normalizes WMS URLs to include a query separator', () => {
    assert.equal(normalizeWmsUrl('https://example.test/geoserver/wms'), 'https://example.test/geoserver/wms?');
    assert.equal(normalizeWmsUrl(' https://example.test/geoserver/wms? '), 'https://example.test/geoserver/wms?');
    assert.equal(normalizeWmsUrl(''), null);
  });
});
