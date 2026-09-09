import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { __test } from './windflow.js';

const {
  samplePointsForZoom,
  getSampleStep,
  cropGribField,
  cropWindGrib,
  buildRenderKey,
  getWindDatasetIso,
  windDataTimestamp,
  windDataVersion,
  fetchWindJson,
} = __test;

function makeField(parameterNumber = 2) {
  return {
    header: {
      parameterNumber,
      refTime: '2026-09-09T12:00:00.000Z',
      lo1: -2,
      la1: 52,
      lo2: 2,
      la2: 50,
      nx: 5,
      ny: 3,
      dx: 1,
      dy: 1,
      scanMode: 0,
    },
    data: Array.from({ length: 15 }, (_, idx) => idx + parameterNumber),
  };
}

describe('windflow sampling', () => {
  it('uses deterministic modulo sampling by zoom rules', () => {
    const points = Array.from({ length: 12 }, (_, idx) => ({ lat: idx, lon: idx, speed: 1, dir: 0 }));

    const lowZoomSample = samplePointsForZoom(points, 3);
    const midZoomSample = samplePointsForZoom(points, 5);
    const highZoomSample = samplePointsForZoom(points, 8);

    assert.equal(lowZoomSample.length, 3, 'zoom<=4 should keep 25% (step 4)');
    assert.equal(midZoomSample.length, 6, 'zoom 5–6 should keep 50% (step 2)');
    assert.equal(highZoomSample.length, 12, 'zoom>=7 should keep all points (step 1)');
    assert.deepEqual(samplePointsForZoom(points, 3), lowZoomSample);
  });

  it('returns expected sampling step for boundaries', () => {
    assert.equal(getSampleStep(0), 4);
    assert.equal(getSampleStep(4), 4);
    assert.equal(getSampleStep(5), 2);
    assert.equal(getSampleStep(6), 2);
    assert.equal(getSampleStep(7), 1);
  });
});

describe('windflow viewport cropping', () => {
  it('crops a GRIB field to the visible bounds', () => {
    const cropped = cropGribField(makeField(), {
      west: -0.8,
      east: 0.8,
      north: 51.8,
      south: 50.2,
    });

    assert.equal(cropped.header.lo1, -1);
    assert.equal(cropped.header.lo2, 1);
    assert.equal(cropped.header.nx, 3);
    assert.equal(cropped.header.ny, 3);
    assert.equal(cropped.data.length, 9);
  });

  it('returns null instead of rendering an edge strip outside the dataset', () => {
    const cropped = cropGribField(makeField(), {
      west: -120,
      east: -110,
      north: 45,
      south: 35,
    });

    assert.equal(cropped, null);
  });

  it('requires both wind components to overlap the viewport', () => {
    const payload = {
      meta: { datasetTime: '2026-09-09T12:00:00.000Z' },
      data: [makeField(2), makeField(3)],
    };

    assert.equal(cropWindGrib(payload, {
      west: 20,
      east: 25,
      north: 60,
      south: 55,
    }), null);
  });
});

describe('windflow refresh metadata', () => {
  it('uses datasetTime as the stable version instead of download time', () => {
    const payload = {
      meta: {
        datasetTime: '2026-09-09T12:00:00.000Z',
        updatedAt: '2026-09-09T13:20:00.000Z',
      },
      data: [makeField(2), makeField(3)],
    };

    assert.equal(getWindDatasetIso(payload), '2026-09-09T12:00:00.000Z');
    assert.equal(windDataVersion(payload), '2026-09-09T12:00:00.000Z');
    assert.equal(windDataTimestamp(payload), Date.parse('2026-09-09T12:00:00.000Z'));
  });

  it('changes the render key when either dataset or cropped grid changes', () => {
    const first = {
      meta: { datasetTime: '2026-09-09T12:00:00.000Z' },
      data: [makeField(2), makeField(3)],
    };
    const same = structuredClone(first);
    const newer = structuredClone(first);
    newer.meta.datasetTime = '2026-09-09T18:00:00.000Z';
    const shifted = structuredClone(first);
    shifted.data[0].header.lo1 = -1;

    assert.equal(buildRenderKey(first), buildRenderKey(same));
    assert.notEqual(buildRenderKey(first), buildRenderKey(newer));
    assert.notEqual(buildRenderKey(first), buildRenderKey(shifted));
  });

  it('aborts a stalled wind JSON request', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });

    try {
      await assert.rejects(fetchWindJson('/wind/current.json', 5), /Timeout nach 5 ms/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
