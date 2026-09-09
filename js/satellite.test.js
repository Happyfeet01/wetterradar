import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EUMETVIEW_SAT_BOUNDS,
  EUMETVIEW_SAT_IMAGE,
  EUMETVIEW_SAT_LAYER,
  EUMETVIEW_WMS,
  EUMETVIEW_WMS_FALLBACKS,
} from './config.js';
import { __test, loadSatellite } from './satellite.js';

const {
  buildEndpointList,
  buildFallbackFrames,
  buildGetCapabilitiesUrl,
  buildGetMapUrl,
  buildActiveGetMapUrl,
  expandTimeInterval,
  expandTimeList,
  extractLayerXml,
  fetchWithTimeout,
  findNearestFrameIndex,
  getImageConfig,
  isNearCurrentTime,
  normalizeWmsUrl,
  parseIsoPeriodMs,
  parseSatelliteTimes,
  toSatelliteFrame,
} = __test;

function capabilitiesXml(times = '2026-09-09T16:20:00Z/2026-09-09T16:40:00Z/PT10M'){
  return `<WMS_Capabilities><Capability><Layer><Layer>
    <Name>${EUMETVIEW_SAT_LAYER}</Name>
    <Dimension name="time">${times}</Dimension>
  </Layer></Layer></Capability></WMS_Capabilities>`;
}

describe('EUMETView satellite WMS configuration', () => {
  it('uses the current MTG GeoColour layer', () => {
    assert.equal(EUMETVIEW_SAT_LAYER, 'mtg_fd:rgb_geocolour');
  });

  it('prefers the same-origin proxy and keeps the official endpoint as fallback', () => {
    const endpoints = buildEndpointList(EUMETVIEW_WMS, EUMETVIEW_WMS_FALLBACKS);
    assert.equal(endpoints[0], '/eumetview/wms?');
    assert.ok(endpoints.includes('https://view.eumetsat.int/geoserver/wms?'));
    assert.equal(new Set(endpoints).size, endpoints.length);
  });

  it('normalizes WMS URLs to include a query separator', () => {
    assert.equal(normalizeWmsUrl('https://example.test/geoserver/wms'), 'https://example.test/geoserver/wms?');
    assert.equal(normalizeWmsUrl(' /eumetview/wms? '), '/eumetview/wms?');
    assert.equal(normalizeWmsUrl(''), null);
  });

  it('builds GetMap URLs with an explicit time parameter', () => {
    const url = buildGetMapUrl(EUMETVIEW_WMS, '2026-09-09T16:40:00.000Z');
    const parsed = new URL(url, 'https://wetter.example');

    assert.equal(parsed.pathname, '/eumetview/wms');
    assert.equal(parsed.searchParams.get('service'), 'WMS');
    assert.equal(parsed.searchParams.get('version'), '1.3.0');
    assert.equal(parsed.searchParams.get('request'), 'GetMap');
    assert.equal(parsed.searchParams.get('layers'), EUMETVIEW_SAT_LAYER);
    assert.equal(parsed.searchParams.get('crs'), 'EPSG:4326');
    assert.equal(parsed.searchParams.get('bbox'), '30,-13,65,40');
    assert.equal(parsed.searchParams.get('width'), String(EUMETVIEW_SAT_IMAGE.width));
    assert.equal(parsed.searchParams.get('height'), String(EUMETVIEW_SAT_IMAGE.height));
    assert.equal(parsed.searchParams.get('time'), '2026-09-09T16:40:00.000Z');
    assert.equal(parsed.searchParams.has('_refresh'), false);
  });

  it('pins a current request to the newest time advertised by GetCapabilities', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => capabilitiesXml(),
    });

    try {
      await loadSatellite({ discover: true, force: true });
      const parsed = new URL(buildActiveGetMapUrl(EUMETVIEW_WMS), 'https://wetter.example');
      assert.equal(parsed.searchParams.get('time'), '2026-09-09T16:40:00.000Z');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('treats a slightly delayed radar frame as current', () => {
    const now = Date.parse('2026-09-09T17:00:00Z');
    assert.equal(isNearCurrentTime((now - 20 * 60 * 1000) / 1000, now), true);
    assert.equal(isNearCurrentTime((now - 60 * 60 * 1000) / 1000, now), false);
  });

  it('builds a GetCapabilities URL for EUMETView', () => {
    const parsed = new URL(buildGetCapabilitiesUrl('https://view.eumetsat.int/geoserver/wms?'));
    assert.equal(parsed.origin + parsed.pathname, 'https://view.eumetsat.int/geoserver/wms');
    assert.equal(parsed.searchParams.get('service'), 'WMS');
    assert.equal(parsed.searchParams.get('version'), '1.3.0');
    assert.equal(parsed.searchParams.get('request'), 'GetCapabilities');
  });

  it('expands 10-minute WMS time intervals', () => {
    assert.equal(parseIsoPeriodMs('PT10M'), 10 * 60 * 1000);
    assert.deepEqual(expandTimeList('2026-07-10T00:00:00Z/2026-07-10T00:20:00Z/PT10M'), [
      '2026-07-10T00:00:00.000Z',
      '2026-07-10T00:10:00.000Z',
      '2026-07-10T00:20:00.000Z',
    ]);
  });

  it('keeps the newest capability frames when an interval is very long', () => {
    const values = expandTimeInterval('2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z', 'PT10M');
    assert.equal(values.length, 240);
    assert.equal(values.at(-1), '2026-07-10T00:00:00.000Z');
  });

  it('extracts the exact nested WMS layer', () => {
    const xml = `<WMS_Capabilities><Capability><Layer>
      <Name>root</Name>
      <Layer><Name>other:layer</Name><Dimension name="time">2020-01-01T00:00:00Z</Dimension></Layer>
      <Layer queryable="1"><Name>${EUMETVIEW_SAT_LAYER}</Name>
        <Dimension name="time">2026-07-10T00:00:00Z/2026-07-10T00:20:00Z/PT10M</Dimension>
        <Layer><Name>nested:child</Name></Layer>
      </Layer>
    </Layer></Capability></WMS_Capabilities>`;

    const layerXml = extractLayerXml(xml);
    assert.match(layerXml, /2026-07-10T00:20:00Z/);
    assert.doesNotMatch(layerXml, /other:layer/);
  });

  it('parses the GeoColour layer time dimension', () => {
    assert.deepEqual(parseSatelliteTimes(capabilitiesXml('2026-07-10T00:00:00Z/2026-07-10T00:20:00Z/PT10M')), [
      '2026-07-10T00:00:00.000Z',
      '2026-07-10T00:10:00.000Z',
      '2026-07-10T00:20:00.000Z',
    ]);
  });

  it('normalizes discovered WMS times to the common frame shape', () => {
    assert.deepEqual(toSatelliteFrame('2026-07-10T09:20:00Z'), {
      time: Date.parse('2026-07-10T09:20:00Z') / 1000,
      iso: '2026-07-10T09:20:00.000Z',
    });
    assert.equal(toSatelliteFrame('not-a-date'), null);
  });

  it('creates four hours of 10-minute fallback frames', () => {
    const frames = buildFallbackFrames(Date.parse('2026-07-10T02:34:00Z'));
    const target = Date.parse('2026-07-10T02:12:00Z') / 1000;
    assert.equal(frames.length, 24);
    assert.equal(frames.at(-1).iso, '2026-07-10T02:30:00.000Z');
    assert.equal(frames.at(-2).iso, '2026-07-10T02:20:00.000Z');
    assert.equal(typeof findNearestFrameIndex, 'function');
    assert.ok(Number.isFinite(target));
  });

  it('keeps the image overlay bounds in Leaflet south-west/north-east order', () => {
    const { bounds, width, height } = getImageConfig();
    assert.deepEqual(bounds, EUMETVIEW_SAT_BOUNDS);
    assert.deepEqual(bounds[0], [30, -13]);
    assert.deepEqual(bounds[1], [65, 40]);
    assert.equal(width, 1200);
    assert.equal(height, 800);
  });

  it('does not fetch EUMETView during the boot preparation call', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error('should not fetch'); };
    try {
      await loadSatellite();
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aborts capabilities requests after the configured timeout', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });

    try {
      await assert.rejects(fetchWithTimeout('https://example.test/wms', {}, 5), /Timeout nach 5 ms/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
