import { describe, expect, it } from 'vitest';
import { MediaClockHealth } from './mediaClock';

function deck() { return { currentTime: 30, playbackRate: 1, paused: false, seeking: false, readyState: 4 }; }
describe('renderer continuity', () => {
  it('detects a creeping clock, including the drive trace deficit without waiting or a large regression', () => {
    const clock = new MediaClockHealth(), media = deck();
    clock.observe(media, 0);
    for (let i = 1; i < 5; i++) { media.currentTime += 0.13; expect(clock.observe(media, i * 200)).toBeNull(); }
    media.currentTime += 0.13;
    expect(clock.observe(media, 1000)).toBe('clock_starved');
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
