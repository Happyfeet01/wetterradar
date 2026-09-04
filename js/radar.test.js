import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getLastError, loadRadar, __test } from './radar.js';

const { fetchWithTimeout, radarUrl, reset } = __test;

describe('RainViewer radar loading', () => {
  it('throttles repeated metadata loads within the refresh window', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const frameTime = Math.floor(Date.now() / 1000) - 60;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          host: 'https://tilecache.rainviewer.com',
          radar: { past: [{ time: frameTime, path: `/v2/radar/${frameTime}` }] },
        }),
      };
    };

    try {
      reset();
      await loadRadar();
      await loadRadar();
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
      reset();
    }
  });

  it('exposes an error state instead of hanging when RainViewer fails', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' });

    try {
      reset();
      const frames = await loadRadar({ force: true });
      assert.deepEqual(frames, []);
      assert.match(getLastError()?.message ?? '', /HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
      reset();
    }
  });

  it('aborts a hanging metadata request', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });

    try {
      await assert.rejects(fetchWithTimeout('/rainviewer/weather-maps.json', {}, 5), /Timeout nach 5 ms/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses cacheable RainViewer tile URLs without an extra cache-buster', () => {
    reset();
    const url = radarUrl(
      { time: 123, path: '/v2/radar/123' },
      { chkSmooth: { checked: true } },
    );

    assert.equal(url, 'https://tilecache.rainviewer.com/v2/radar/123/512/{z}/{x}/{y}/8/1_0.png');
    assert.equal(url.includes('?'), false);
  });
});
