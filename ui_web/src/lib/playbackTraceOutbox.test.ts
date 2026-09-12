import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackTraceOutbox, type TraceBatch } from './playbackTraceOutbox';
import { recordPlaybackDiagnostic, startAutomaticPlaybackDiagnostics } from './playbackDiagnostics';

const setup = { userId: 'user', deviceId: 'device', platform: 'test', displayMode: 'browser' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const batch = (id: string): TraceBatch => ({ id, userId: 'user', createdAt: Date.now(), capture: {}, dropped: 0, events: [{}] });

describe('automatic trace delivery', () => {
  it('continues in bounded memory when browser storage is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const outbox = new PlaybackTraceOutbox('user');
    await outbox.put(batch('first'));
    expect(outbox.volatile).toBe(true);
    expect((await outbox.pending()).map((b) => b.id)).toEqual(['first']);
    await outbox.remove('first');
    expect(await outbox.pending()).toEqual([]);
  });

  it('reports expiry instead of pretending all evidence was retained', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const outbox = new PlaybackTraceOutbox('user');
    await outbox.put({ ...batch('old'), createdAt: Date.now() - 8 * 86400_000 });
    await outbox.put(batch('new'));
    expect((await outbox.pending()).map((b) => b.id)).toEqual(['new']);
    expect(outbox.lost).toBe(1);
  });

  it('starts unaided and retries a failed acknowledgement without changing batch identity', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', undefined);
    const sent: TraceBatch[] = [];
    let fail = true;
    cleanups.push(startAutomaticPlaybackDiagnostics(setup, async (b) => {
      sent.push(b);
      if (fail) throw new Error('offline');
      return { id: b.id, enabled: true };
    }));
    await vi.advanceTimersByTimeAsync(1);
    expect(sent[0].events).toEqual([expect.objectContaining({ event: 'capture.start' })]);
    fail = false;
    recordPlaybackDiagnostic('handoff.retirement', { from: 0, to: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent.filter((b) => b.id === sent[0].id)).toHaveLength(2);
    expect(sent.some((b) => b.events.some((e) => (e as { event: string }).event === 'handoff.retirement'))).toBe(true);
    const count = sent.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent).toHaveLength(count);
  });

  it('drains evidence faster than it accumulates during continuous playback', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', undefined);
    const sent: TraceBatch[] = [];
    cleanups.push(startAutomaticPlaybackDiagnostics(setup, async (b) => {
      sent.push(b);
      return { id: b.id, enabled: true };
    }));
    await vi.advanceTimersByTimeAsync(1);
    for (let index = 0; index < 60; index++) {
      recordPlaybackDiagnostic('sample');
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(5000);
    const samples = sent.flatMap((b) => b.events).filter((row) => (row as { event: string }).event === 'sample');
    expect(samples).toHaveLength(60);
  });

  it('does not send queued evidence after the authenticated account changes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', undefined);
    let sameUser = false;
    const send = vi.fn(async (b: TraceBatch) => ({ id: b.id, enabled: true }));
    cleanups.push(startAutomaticPlaybackDiagnostics(setup, send, () => sameUser));
    recordPlaybackDiagnostic('sample');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send).not.toHaveBeenCalled();
    sameUser = true;
    recordPlaybackDiagnostic('sample');
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledOnce();
  });

  it('preserves event sequences across size-limited diagnostic batches', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', undefined);
    const sent: TraceBatch[] = [];
    cleanups.push(startAutomaticPlaybackDiagnostics(setup, async (b) => {
      sent.push(b);
      return { id: b.id, enabled: true };
    }));
    await vi.advanceTimersByTimeAsync(1);
    for (let index = 0; index < 30; index++) {
      recordPlaybackDiagnostic('large-sample', { index, padding: 'x'.repeat(7000) });
    }
    await vi.advanceTimersByTimeAsync(15_000);
    const samples = sent.flatMap(b => b.events).filter(row => (row as { event: string }).event === 'large-sample');
    // Upload order can differ for batches with the same timestamp; sequence
    // numbers are the recorder/server's authoritative reconstruction order.
    samples.sort((a, b) => (a as { sequence: number }).sequence - (b as { sequence: number }).sequence);
    expect(samples.map(row => (row as { facts: { index: number } }).facts.index)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(sent.every(b => JSON.stringify(b.events).length <= 40_000)).toBe(true);
  });

});
