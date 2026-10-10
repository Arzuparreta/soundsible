import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgramOutput } from './programOutput';

class FakeCarrier extends EventTarget {
  paused = true;
  ended = false;
  readyState = 4;
  preload = '';
  srcObject: MediaStream | null = null;
  error: MediaError | null = null;
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
  });
  pause = vi.fn(() => {
    const changed = !this.paused;
    this.paused = true;
    if (changed) this.dispatchEvent(new Event('pause'));
  });
}

function fixture() {
  const track = { stop: vi.fn() };
  const destination = { stream: { getTracks: () => [track] } };
  const context = {
    state: 'running',
    destination: { name: 'speakers' },
    createMediaStreamDestination: vi.fn(() => destination),
  } as unknown as AudioContext;
  const monitor = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;
  const output = new ProgramOutput(context, monitor);
  const events: string[] = [];
  output.subscribe((event) => events.push(event.event));
  return { output, context, monitor, track, events };
}

beforeEach(() => {
  vi.stubGlobal('Audio', FakeCarrier);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('stable programme output', () => {
  it.each([
    ['iPhone', 'iPhone', 5],
    ['iPad', 'iPad', 5],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'MacIntel', 5],
    // WebKitGTK, as in GNOME Web.
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'Linux x86_64', 0],
  ])('uses direct output on %s without creating or retrying a carrier', async (userAgent, platform, maxTouchPoints) => {
    vi.stubGlobal('navigator', { userAgent, platform, maxTouchPoints });
    const { output, context, monitor, events } = fixture();
    expect(output.initialize()).toBe('direct');
    expect(output.initialize()).toBe('direct');
    await output.play();
    output.pause();
    expect(await output.retryFromGesture(true)).toBe(false);
    expect(context.createMediaStreamDestination).not.toHaveBeenCalled();
    expect(monitor.connect).toHaveBeenCalledExactlyOnceWith(context.destination);
    expect(events).toEqual(['direct_attached']);
    expect(output.snapshot()).toMatchObject({ mode: 'direct', carrierPlaying: false });
    output.destroy();
    expect(monitor.disconnect).toHaveBeenCalledExactlyOnceWith(context.destination);
  });

  it.each([
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  ])('keeps the carrier for Linux browsers other than WebKitGTK: %s', (userAgent) => {
    vi.stubGlobal('navigator', { userAgent, platform: 'Linux x86_64', maxTouchPoints: 0 });
    expect(fixture().output.initialize()).toBe('carrier');
  });

  it('abandons a carrier that plays without ever producing a frame', async () => {
    vi.useFakeTimers();
    try {
      const { output, context, monitor, events } = fixture();
      output.initialize();
      const carrier = (output as unknown as { carrier: FakeCarrier }).carrier;
      carrier.readyState = 0;

      await output.play();
      expect(output.snapshot().mode).toBe('carrier');
      vi.advanceTimersByTime(2000);

      expect(output.snapshot().mode).toBe('direct_fallback');
      expect(carrier.pause).toHaveBeenCalled();
      expect(monitor.connect).toHaveBeenLastCalledWith(context.destination);
      expect(events.at(-1)).toBe('fallback_entered');
      // A gesture must not put the listener back on the silent carrier.
      expect(await output.retryFromGesture(true)).toBe(false);
      expect(output.snapshot().mode).toBe('direct_fallback');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a carrier that has a frame by the deadline', async () => {
    vi.useFakeTimers();
    try {
      const { output } = fixture();
      output.initialize();
      await output.play();
      vi.advanceTimersByTime(2000);
      expect(output.snapshot().mode).toBe('carrier');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the carrier for desktop Macs', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 });
    expect(fixture().output.initialize()).toBe('carrier');
  });
  it('keeps one carrier through play and pause and reports its real state', async () => {
    const { output, context, monitor, events } = fixture();

    expect(output.initialize()).toBe('carrier');
    expect(context.createMediaStreamDestination).toHaveBeenCalledOnce();
    expect(monitor.connect).toHaveBeenCalledOnce();

    await output.play();
    expect(output.snapshot()).toMatchObject({ mode: 'carrier', carrierPlaying: true });
    output.pause();
    expect(output.snapshot()).toMatchObject({ mode: 'carrier', carrierPlaying: false });
    expect(events).toEqual(['carrier_attached', 'carrier_playing', 'carrier_paused']);
  });

  it('falls back to direct output without silencing the programme when carrier play fails', async () => {
    const { output, context, monitor, events } = fixture();
    output.initialize();
    const carrier = (output as unknown as { carrier: FakeCarrier }).carrier;
    carrier.play.mockRejectedValueOnce(new DOMException('gesture required', 'NotAllowedError'));

    await output.play();

    expect(output.snapshot().mode).toBe('direct_fallback');
    expect(monitor.connect).toHaveBeenLastCalledWith(context.destination);
    expect(events).toEqual(['carrier_attached', 'carrier_error', 'fallback_entered']);
  });

  it('only leaves direct fallback after a gesture has started the carrier', async () => {
    const { output, context, monitor, events } = fixture();
    output.initialize();
    const carrier = (output as unknown as { carrier: FakeCarrier }).carrier;
    carrier.play.mockRejectedValueOnce(new DOMException('gesture required', 'NotAllowedError'));
    await output.play();

    expect(await output.retryFromGesture(false)).toBe(false);
    expect(await output.retryFromGesture(true)).toBe(true);
    expect(monitor.disconnect).toHaveBeenCalledWith(context.destination);
    expect(output.snapshot().mode).toBe('carrier');
    expect(events.at(-1)).toBe('fallback_recovered');
  });
});
