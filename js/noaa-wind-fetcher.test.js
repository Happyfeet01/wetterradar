import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidates, buildNomadsUrl } from '../tools/noaa-wind-fetcher.js';

test('NOAA GFS 1 degree filename uses official 1p00 spelling', () => {
  const url = new URL(buildNomadsUrl('20260909', '06'));
  assert.equal(url.searchParams.get('file'), 'gfs.t06z.pgrb2.1p00.f000');
  assert.equal(url.searchParams.get('dir'), '/gfs.20260909/06/atmos');
});

test('candidate list does not query future GFS cycles', () => {
  const candidates = buildCandidates(new Date('2026-09-09T15:33:00Z'));
  assert.deepEqual(candidates.slice(0, 3), [
    { date: '20260909', cycle: '12' },
    { date: '20260909', cycle: '06' },
    { date: '20260909', cycle: '00' },
  ]);
  assert.equal(candidates.some(item => item.date === '20260909' && item.cycle === '18'), false);
});

test('18z becomes eligible after 18 UTC', () => {
  const candidates = buildCandidates(new Date('2026-09-09T18:01:00Z'));
  assert.deepEqual(candidates[0], { date: '20260909', cycle: '18' });
});
