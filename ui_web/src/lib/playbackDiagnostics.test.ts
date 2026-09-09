import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnosticPlay, diagnosticPause, diagnosticStatus, observeDiagnosticMedia, playbackDiagnosticExport,
  recordPlaybackDiagnostic, setDiagnosticSnapshot, startPlaybackDiagnostics, stopPlaybackDiagnostics } from './playbackDiagnostics';

const setup = { userId: 'user', deviceId: 'device', platform: 'test', displayMode: 'browser' };
const cleanups: Array<() => void> = [];
afterEach(() => {
  stopPlaybackDiagnostics();
  for (const cleanup of cleanups.splice(0)) cleanup();
  setDiagnosticSnapshot(() => ({}));
  vi.restoreAllMocks();
});

function media() {
  const element = document.createElement('audio');
  element.src = 'https://private.invalid/song?credential=secret';
  cleanups.push(observeDiagnosticMedia(element, 'deck'));
  return element;
}
const exported = () => JSON.parse(playbackDiagnosticExport());

describe('local playback flight recorder', () => {
  it('does not change play promises or observe them while disabled', () => {
    const element = media();
    const promise = Promise.resolve();
    element.play = () => promise;
    const then = vi.spyOn(promise, 'then');
    expect(diagnosticPlay(element)).toBe(promise);
    expect(then).not.toHaveBeenCalled();
  });

  it('records native events before subsequent listeners and keeps URLs out', async () => {
    const element = media();
    element.addEventListener('pause', () => recordPlaybackDiagnostic('store.filtered_pause'));
    vi.spyOn(element, 'pause').mockImplementation(() => element.dispatchEvent(new Event('pause')));
    vi.spyOn(element, 'play').mockResolvedValue();
    startPlaybackDiagnostics(setup);
    await diagnosticPlay(element);
    diagnosticPause(element);
    const data = exported();
    expect(data.events.map((row: { event: string }) => row.event)).toEqual([
      'capture.start', 'call.play', 'return.play', 'resolve.play', 'call.pause', 'media.pause', 'store.filtered_pause', 'return.pause',
    ]);
    expect(data.events.map((row: { sequence: number }) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(playbackDiagnosticExport()).not.toMatch(/private\.invalid|credential|secret/);
    expect(data.events[0].media[0].hasSource).toBe(true);
  });

  it('does not attribute a late play settlement to a new capture', async () => {
    const element = media();
    let resolve!: () => void;
    vi.spyOn(element, 'play').mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    startPlaybackDiagnostics(setup);
    const promise = diagnosticPlay(element);
    stopPlaybackDiagnostics();
    startPlaybackDiagnostics(setup);
    resolve();
    await promise;
    expect(exported().events).toHaveLength(1);
  });

  it('keeps explicit loss counts and monotonic order when full', () => {
    startPlaybackDiagnostics(setup);
    for (let i = 0; i < 4200; i++) recordPlaybackDiagnostic('sample');
    const data = exported();
    expect(data.ringDiscarded).toBe(105);
    expect(data.dropped).toBe(0);
    expect(data.events).toHaveLength(4096);
    expect(data.events[0].sequence).toBe(106);
    expect(data.events.at(-1).sequence).toBe(4201);
  });

  it('preserves rejection identity and never exports error messages', async () => {
    const element = media();
    const error = new DOMException('private URL secret', 'NotAllowedError');
    vi.spyOn(element, 'play').mockRejectedValue(error);
    startPlaybackDiagnostics(setup);
    await expect(diagnosticPlay(element)).rejects.toBe(error);
    expect(exported().events.at(-1).facts.error).toBe('NotAllowedError');
    expect(playbackDiagnosticExport()).not.toContain('secret');
  });

  it('counts recorder failures without throwing into playback', () => {
    startPlaybackDiagnostics(setup);
    setDiagnosticSnapshot(() => { throw new Error('snapshot unavailable'); });
    expect(() => recordPlaybackDiagnostic('sample')).not.toThrow();
    expect(diagnosticStatus().dropped).toBe(1);
  });
});
