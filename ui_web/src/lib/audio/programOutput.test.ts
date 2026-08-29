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
  vi.unstubAllGlobals();
});

describe('stable programme output', () => {
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
