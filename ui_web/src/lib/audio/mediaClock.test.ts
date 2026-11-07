import { describe, expect, it } from 'vitest';
import { MediaClockHealth } from './mediaClock';

function deck() { return { currentTime: 30, playbackRate: 1, paused: false, seeking: false, readyState: 4 }; }
describe('renderer continuity', () => {
  it('detects a creeping clock, including the drive trace deficit without waiting or a large regression', () => {
    const clock = new MediaClockHealth(), media = deck();
    clock.observe(media, 0);
    for (let i = 1; i < 5; i++) { media.currentTime += 0.13; expect(clock.observe(media, i * 200)).toBeNull(); }
    media.currentTime += 0.13;
    expect(clock.observe(media, 1000)).toBeNull(); // suspect, not confirmed
    for (let i = 6; i < 10; i++) { media.currentTime += 0.13; expect(clock.observe(media, i * 200)).toBeNull(); }
    media.currentTime += 0.13;
    expect(clock.observe(media, 2000)).toBe('clock_starved');
  });
  it.each([450, 650])('accepts a finite %i ms activation delay followed by steady progress', delay => {
    const clock = new MediaClockHealth(), media = deck();
    for (let at = 0; at <= 5000; at += 100) {
      media.currentTime = 30 + Math.max(0, at - delay) / 1000;
      expect(clock.observe(media, at)).toBeNull();
    }
  });
  it('clears suspicion after a healthy window instead of accumulating unrelated interruptions', () => {
    const clock = new MediaClockHealth(), media = deck();
    for (let at = 0; at <= 4000; at += 100) {
      // One 400 ms hold in each of two non-consecutive windows.
      const delay = at < 2000 ? Math.min(at, 400) : 400 + Math.min(at - 2000, 400);
      media.currentTime = 30 + (at - delay) / 1000;
      expect(clock.observe(media, at)).toBeNull();
    }
  });
  it('confirms a source that never advances within two complete windows', () => {
    const clock = new MediaClockHealth(), media = deck();
    for (let at = 0; at < 2000; at += 100) expect(clock.observe(media, at)).toBeNull();
    expect(clock.observe(media, 2000)).toBe('clock_starved');
  });
  it.each(['reset', 'paused', 'seeking', 'unready', 'gap'] as const)('discards suspicion on %s', reason => {
    const clock = new MediaClockHealth(), media = deck();
    for (let at = 0; at <= 1000; at += 100) clock.observe(media, at);
    if (reason === 'reset') clock.reset();
    if (reason === 'paused' || reason === 'seeking') media[reason] = true;
    if (reason === 'unready') media.readyState = 2;
    const resumeAt = reason === 'gap' ? 4000 : 1100;
    expect(clock.observe(media, resumeAt)).toBeNull();
    media.paused = media.seeking = false; media.readyState = 4;
    // A fresh bad window is still only suspicion, even after a previous one.
    for (let at = resumeAt + 100; at <= resumeAt + 1100; at += 100) {
      expect(clock.observe(media, at)).toBeNull();
    }
  });
  it('detects cumulative small regressions against the high water mark', () => {
    const clock = new MediaClockHealth(), media = deck(); clock.observe(media, 0);
    media.currentTime -= 0.03; expect(clock.observe(media, 40)).toBeNull();
    media.currentTime -= 0.03; expect(clock.observe(media, 80)).toBe('clock_regressed');
  });
  it('integrates requested speed and tolerates the media update quantum', () => {
    const clock = new MediaClockHealth(), media = deck();
    for (let i = 0; i < 100; i++) {
      media.playbackRate = i < 50 ? 0.92 : 1.08;
      if (i) media.currentTime += i <= 50 ? 0.092 : 0.108;
      expect(clock.observe(media, i * 100)).toBeNull();
    }
  });
  it.each(['paused', 'seeking', 'gap'] as const)('does not confuse %s with renderer failure', reason => {
    const clock = new MediaClockHealth(), media = deck(); clock.observe(media, 0);
    if (reason !== 'gap') media[reason] = true;
    else media.currentTime = 5;
    expect(clock.observe(media, 4000)).toBeNull();
    media.paused = media.seeking = false; media.currentTime = 5;
    expect(clock.observe(media, 4100)).toBeNull();
  });
});
