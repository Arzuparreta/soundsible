import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackTraceOutbox, type TraceBatch } from './playbackTraceOutbox';
import { recordPlaybackDiagnostic, startAutomaticPlaybackDiagnostics } from './playbackDiagnostics';

const setup = { userId: 'user', deviceId: 'device', platform: 'test', displayMode: 'browser' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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

describe('bounded diagnostic persistence and delivery', () => {
  it('checks network backoff before reading the upload window', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', undefined);
    const reads = vi.spyOn(PlaybackTraceOutbox.prototype, 'pending');
    const send = vi.fn(async () => { throw new Error('offline'); });
    cleanups.push(startAutomaticPlaybackDiagnostics(setup, send));
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toHaveBeenCalledTimes(1);
    recordPlaybackDiagnostic('during-backoff');
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('bounds queued writes behind slow storage and reports the discarded sequences', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', undefined);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realPut = PlaybackTraceOutbox.prototype.put;
    const puts = vi.spyOn(PlaybackTraceOutbox.prototype, 'put').mockImplementationOnce(async function (this: PlaybackTraceOutbox, batch) {
      await gate;
      await realPut.call(this, batch);
    });
    const sent: TraceBatch[] = [];
    cleanups.push(startAutomaticPlaybackDiagnostics(setup, async b => {
      sent.push(b);
      return { id: b.id, enabled: true };
    }));
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 24 * 1000; i++) recordPlaybackDiagnostic('disk-stall', { i });
    await vi.advanceTimersByTimeAsync(2000);
    expect(puts).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(puts.mock.calls.length).toBeLessThanOrEqual(33);
    expect(sent.some(b => b.dropped > 20_000)).toBe(true);
    expect(sent.flatMap(b => b.events).some(row =>
      (row as { facts?: { i?: number } }).facts?.i === 23999)).toBe(true);
  });

  it('retains an ACK mismatch and purges all account batches on server opt-out', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', undefined);
    const clear = vi.spyOn(PlaybackTraceOutbox.prototype, 'clear');
    const sent: TraceBatch[] = [];
    let disabled = false;
    cleanups.push(startAutomaticPlaybackDiagnostics(setup, async b => {
      sent.push(b);
      return { id: disabled ? b.id : 'wrong-ack', enabled: !disabled };
    }));
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 10; i++) {
      recordPlaybackDiagnostic('offline');
      await vi.advanceTimersByTimeAsync(1000);
    }
    disabled = true;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.filter(b => b.id === sent[0].id).length).toBeGreaterThan(1);
    expect(clear).toHaveBeenCalledOnce();
    const count = sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(count);
  });

  it('returns a six-batch window in fallback and rejects cross-account writes', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const outbox = new PlaybackTraceOutbox('user');
    for (let i = 0; i < 20; i++) await outbox.put(batch(String(i).padStart(3, '0')));
    expect((await outbox.pending()).map(b => b.id)).toEqual(['000', '001', '002', '003', '004', '005']);
    await expect(outbox.put({ ...batch('foreign'), userId: 'other' })).rejects.toThrow('trace_account_mismatch');
    await outbox.clear();
    expect(await outbox.pending()).toEqual([]);
  });
});
