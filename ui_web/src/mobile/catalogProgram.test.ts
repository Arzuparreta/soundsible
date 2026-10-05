import { expect, it, vi } from 'vitest';
import { resolveNativeCatalogProgram } from './catalogProgram';
import type { CatalogItem, Track } from '../types/music';
const item = (id: string): CatalogItem => ({ id, title: id, type: 'library_track', source: 'library' });
const track = (id: string): Track => ({ id, title: id, artist: 'Artist' });
it('keeps occurrences and the selected index when other recordings are unavailable', async () => {
  const resolve = vi.fn(async (row: CatalogItem) => row.id === 'missing' ? null : track(row.id));
  const result = await resolveNativeCatalogProgram([item('missing'), item('same'), item('same')], 2, resolve, () => true);
  expect(result.tracks.map(row => row.id)).toEqual(['same', 'same']);
  expect(result.index).toBe(1); expect(result.unavailable).toBe(1);
});
it('rejects unavailable selected recordings instead of starting a different song', async () => {
  await expect(resolveNativeCatalogProgram([item('missing'), item('other')], 0, async row => row.id === 'missing' ? null : track(row.id), () => true)).rejects.toThrow('Selected recording unavailable');
});
it('limits provider concurrency and cancels without publishing a stale program', async () => {
  let active = 0, maximum = 0, current = true;
  const gates: (() => void)[] = [];
  const resolve = vi.fn(async (row: CatalogItem) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise<void>(done => gates.push(done)); active--; return track(row.id);
  });
  const operation = resolveNativeCatalogProgram(Array.from({ length: 8 }, (_, index) => item(String(index))), 0, resolve, () => current);
  expect(resolve).toHaveBeenCalledTimes(3);
  current = false; gates.forEach(done => done());
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  expect(maximum).toBe(3); expect(resolve).toHaveBeenCalledTimes(3); expect(active).toBe(0);
});
