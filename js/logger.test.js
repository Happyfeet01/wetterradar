import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { __test, sanitizeUrl } from './logger.js';

describe('client diagnostics logger', () => {
  it('keeps weather/WMS parameters but redacts unknown query values', () => {
    const url = sanitizeUrl('https://example.test/wms?service=WMS&request=GetMap&time=2026-09-09T12%3A00%3A00Z&token=secret');
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('service'), 'WMS');
    assert.equal(parsed.searchParams.get('request'), 'GetMap');
    assert.equal(parsed.searchParams.get('time'), '2026-09-09T12:00:00Z');
    assert.equal(parsed.searchParams.get('token'), '[redacted]');
  });

  it('redacts sensitive object fields and caps long strings', () => {
    const cleaned = __test.safeValue({ token: 'abc', password: 'xyz', message: 'a'.repeat(5000) });
    assert.equal(cleaned.token, '[redacted]');
    assert.equal(cleaned.password, '[redacted]');
    assert.equal(cleaned.message.length, 4000);
  });
});
