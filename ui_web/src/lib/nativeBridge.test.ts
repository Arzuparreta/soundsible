import { describe, expect, it, vi, afterEach } from 'vitest';
import { reportNowPlaying, installNativeControl } from './nativeBridge';

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
    reportNowPlaying({ title: 'Song', artist: 'Band', album: 'Record' }, true, 'https://x/cover.jpg');
    expect(onTrackChanged).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onTrackChanged.mock.calls[0][0])).toEqual({
      title: 'Song', artist: 'Band', album: 'Record', playing: true, coverUrl: 'https://x/cover.jpg',
    });
  });

  it('reports an empty payload when nothing sounds', () => {
    const onTrackChanged = vi.fn();
    vi.stubGlobal('window', { SoundsibleNative: { onTrackChanged } } as never);
    reportNowPlaying(null, false);
    expect(JSON.parse(onTrackChanged.mock.calls[0][0]).playing).toBe(false);
  });

  it('installs transport hooks the shell can call', () => {
    const control = { pause: vi.fn(), play: vi.fn(), toggle: vi.fn(), next: vi.fn(), previous: vi.fn() };
    installNativeControl(control);
    const w = window as unknown as { SoundsibleNativeControl?: typeof control };
    w.SoundsibleNativeControl?.toggle?.();
    w.SoundsibleNativeControl?.next?.();
    w.SoundsibleNativeControl?.play?.();
    expect(control.toggle).toHaveBeenCalledTimes(1);
    expect(control.next).toHaveBeenCalledTimes(1);
    expect(control.play).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing shell', () => {
    vi.stubGlobal('window', {
      SoundsibleNative: { onTrackChanged: () => { throw new Error('gone'); } },
    } as never);
    expect(() => reportNowPlaying({ title: 'T', artist: 'A' }, true)).not.toThrow();
  });
});
