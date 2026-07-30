import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeAudio extends EventTarget {
  src = '';
  currentSrc = '';
  currentTime = 0;
  duration = 240;
  readyState = 1;
  paused = true;
  ended = false;
  volume = 1;
  muted = false;
  playbackRate = 1;
  preservesPitch = true;
  preload = '';
  crossOrigin: string | null = null;

  play = vi.fn(async () => {
    this.paused = false;
    this.currentSrc = this.src;
  });

  pause = vi.fn(() => {
    this.paused = true;
  });

  load = vi.fn();

  removeAttribute(name: string) {
    if (name === 'src') {
      this.src = '';
      this.currentSrc = '';
    }
  }

  getAttribute(name: string) {
    return name === 'src' && this.src ? this.src : null;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('dual-deck audio service', () => {
  it('crossfades live and hands the incoming position back to the canonical deck', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('AudioContext', undefined);
    const { audioEl, audioService } = await import('./audio');
    const primary = audioEl() as unknown as FakeAudio;
    primary.src = '/current';
    primary.currentTime = 10;
    const onDominant = vi.fn();
    const onComplete = vi.fn();

    await audioService.scheduleDjTransition('/next', {
      technique: 'filter_blend',
      out_cue: 10,
      in_cue: 6,
      overlap_seconds: 4,
      overlap_bars: 8,
      playback_rate: 1.02,
      confidence: 0.8,
    }, {
      onDominant,
      onComplete,
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(2050);
    expect(onDominant).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2100);
    expect(primary.src).toBe('/next');
    expect(primary.playbackRate).toBeCloseTo(1.02);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('cancels a prepared transition without replacing the current source', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('AudioContext', undefined);
    const { audioEl, audioService } = await import('./audio');
    const primary = audioEl() as unknown as FakeAudio;
    primary.src = '/current';
    primary.currentTime = 2;
    const onDominant = vi.fn();

    void audioService.scheduleDjTransition('/next', {
      technique: 'safe_fade',
      out_cue: 20,
      in_cue: 0,
      overlap_seconds: 4,
      overlap_bars: 4,
      playback_rate: 1,
      confidence: 0.2,
    }, {
      onDominant,
      onComplete: vi.fn(),
      onError: vi.fn(),
    });
    audioService.cancelDjTransition();
    await vi.advanceTimersByTimeAsync(25_000);

    expect(primary.src).toBe('/current');
    expect(onDominant).not.toHaveBeenCalled();
  });
});
