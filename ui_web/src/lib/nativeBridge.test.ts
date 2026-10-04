import { describe, expect, it, vi, afterEach } from 'vitest';
import { reportNowPlaying } from './nativeBridge';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nativeBridge', () => {
  it('does nothing when no native shell hosts the page', () => {
    vi.stubGlobal('window', undefined);
    expect(() => reportNowPlaying({ title: 'T', artist: 'A' }, true)).not.toThrow();
  });

  it('reports the sounding track as JSON', () => {
    const onTrackChanged = vi.fn();
    vi.stubGlobal('window', { SoundsibleNative: { onTrackChanged } } as never);
    reportNowPlaying({ title: 'Song', artist: 'Band', album: 'Record' }, true);
    expect(onTrackChanged).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onTrackChanged.mock.calls[0][0])).toEqual({
      title: 'Song', artist: 'Band', album: 'Record', playing: true,
    });
  });

  it('reports an empty payload when nothing sounds', () => {
    const onTrackChanged = vi.fn();
    vi.stubGlobal('window', { SoundsibleNative: { onTrackChanged } } as never);
    reportNowPlaying(null, false);
    expect(JSON.parse(onTrackChanged.mock.calls[0][0]).playing).toBe(false);
  });

  it('survives a throwing shell', () => {
    vi.stubGlobal('window', {
      SoundsibleNative: { onTrackChanged: () => { throw new Error('gone'); } },
    } as never);
    expect(() => reportNowPlaying({ title: 'T', artist: 'A' }, true)).not.toThrow();
  });
});
