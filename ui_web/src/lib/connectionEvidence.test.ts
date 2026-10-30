import { beforeEach, expect, it } from 'vitest';
import { noteConnectionFailure, takeConnectionFailures } from './connectionEvidence';
beforeEach(() => sessionStorage.clear());
it('retains only bounded transport outcomes, never error messages or addresses', () => {
  for (let i = 0; i < 20; i++) noteConnectionFailure(new TypeError('https://private.invalid/secret'));
  const rows = takeConnectionFailures();
  expect(rows).toHaveLength(8);
  expect(rows.every(row => row.error === 'TypeError' && row.phase === 'session')).toBe(true);
  expect(JSON.stringify(rows)).not.toMatch(/private|secret/);
  expect(takeConnectionFailures()).toEqual([]);
});
it('rejects poisoned stored fields instead of uploading them', () => {
  sessionStorage.setItem('soundsible-connection-failures', JSON.stringify([{ atMs: 1, error: 'https://private.invalid', phase: 'session' }]));
  expect(takeConnectionFailures()).toEqual([]);
});
