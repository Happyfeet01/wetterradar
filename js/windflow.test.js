import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { __test } from './windflow.js';

const { samplePointsForZoom, getSampleStep } = __test;

describe('windflow sampling', () => {
  it('uses deterministic modulo sampling by zoom rules', () => {
    const points = Array.from({ length: 12 }, (_, idx) => ({ lat: idx, lon: idx, speed: 1, dir: 0 }));

    const lowZoomSample = samplePointsForZoom(points, 3);
    const midZoomSample = samplePointsForZoom(points, 5);
    const highZoomSample = samplePointsForZoom(points, 8);

    assert.equal(lowZoomSample.length, 3, 'zoom<=4 should keep 25% (step 4)');
    assert.equal(midZoomSample.length, 6, 'zoom 5–6 should keep 50% (step 2)');
    assert.equal(highZoomSample.length, 12, 'zoom>=7 should keep all points (step 1)');

    // deterministisch: gleiche Eingabe -> gleiche Auswahl
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
