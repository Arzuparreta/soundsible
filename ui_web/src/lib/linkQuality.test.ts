import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getLinkQuality = vi.fn();
vi.mock('./api', () => ({ api: { getLinkQuality: () => getLinkQuality() } }));

const { HEADROOM, linkFits, linkReading, mbps, refreshLinkReading, resetLinkReading, trackKbps } =
  await import('./linkQuality');
import type { Track } from '../types/music';

const track = (over: Partial<Track> = {}): Track => ({
  id: 't',
  title: 'Corpo e Canção',
  artist: 'Antdot',
  ...over,
});

beforeEach(() => {
  resetLinkReading();
  getLinkQuality.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('trackKbps', () => {
  it('measures the file, not what the encoder was asked for', () => {
    // A 24-bit FLAC: `bitrate` says 1411, the bytes say otherwise, and the bytes
    // are what has to cross the network.
    expect(trackKbps(track({ file_size: 71_309_899, duration: 369, bitrate: 1411 }))).toBeCloseTo(
      1546,
      0,
    );
  });

  it('falls back to the declared bitrate, then to nothing', () => {
    expect(trackKbps(track({ bitrate: 128 }))).toBe(128);
    expect(trackKbps(track())).toBeNull();
    expect(trackKbps(null)).toBeNull();
  });
});

describe('linkFits', () => {
  const flac = track({ file_size: 71_309_899, duration: 369 });

  it('says no when the link cannot carry the track', () => {
    // The measurement that started all this: 0.7 Mbps against a 1.5 Mbps track.
    expect(linkFits({ scope: 'tailnet', kbps: 700, samples: 3, measured_at: 1 }, flac)).toBe(false);
  });

  it('wants headroom, not a photo finish', () => {
    const exactly = { scope: 'lan' as const, kbps: 1546, samples: 3, measured_at: 1 };
    expect(linkFits(exactly, flac)).toBe(false);
    expect(linkFits({ ...exactly, kbps: 1546 * HEADROOM + 1 }, flac)).toBe(true);
  });

  it('says "unknown", not "no", when nothing has been measured', () => {
    expect(linkFits(null, flac)).toBeNull();
    expect(linkFits({ scope: 'lan', kbps: null, samples: 0, measured_at: null }, flac)).toBeNull();
    expect(linkFits({ scope: 'lan', kbps: 9000, samples: 1, measured_at: 1 }, track())).toBeNull();
  });
});

describe('refreshLinkReading', () => {
  it('keeps the last reading', async () => {
    getLinkQuality.mockResolvedValue({ scope: 'tailnet', kbps: 700, samples: 4, measured_at: 2 });

    await refreshLinkReading();

    expect(linkReading()?.kbps).toBe(700);
  });

  it('does not ask again on every stall', async () => {
    getLinkQuality.mockResolvedValue({ scope: 'lan', kbps: 90_000, samples: 9, measured_at: 3 });

    await refreshLinkReading();
    await refreshLinkReading();

    expect(getLinkQuality).toHaveBeenCalledTimes(1);
  });

  it('leaves the screen alone when the engine cannot answer', async () => {
    getLinkQuality.mockRejectedValue(new Error('offline'));

    await refreshLinkReading();

    expect(linkReading()).toBeNull();
  });
});

describe('mbps', () => {
  it('reads speeds the way people do', () => {
    expect(mbps(700)).toBe('0.7');
    expect(mbps(1546)).toBe('1.5');
  });
});
