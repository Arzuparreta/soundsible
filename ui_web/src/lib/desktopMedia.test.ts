import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopMediaSession, type DesktopBridge, type DesktopControls } from './desktopMedia';
import type { ProgramPlaybackSnapshot } from './audio';

const snapshot = { playing: true, position: 42, duration: 180, playbackRate: 1, hasSource: true } as ProgramPlaybackSnapshot;
function setup(media = true) {
  let receiver: ((action: { action: string }) => void) | null = null;
  const bridge: DesktopBridge = {
    handshake: vi.fn().mockResolvedValue({ media }), publish: vi.fn().mockResolvedValue(undefined),
    appearance: vi.fn().mockResolvedValue(undefined),
    onAction: handler => { receiver = handler; return () => { receiver = null; }; },
  };
  const controls: DesktopControls = {
    state: () => ({ volume: 0.5, can_next: true, can_previous: true, repeat: 'off', shuffle: false }),
    snapshot: () => snapshot, act: vi.fn(),
  };
  const connected = vi.fn();
  const session = new DesktopMediaSession(bridge, controls, connected);
  return { session, bridge, controls, connected, send: () => receiver?.({ action: 'pause' }) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('desktop media bridge', () => {
  it('reports the programme without requiring browser Media Session', async () => {
    vi.useFakeTimers();
    const s = setup();
    await Promise.resolve();
    s.session.sync({ id: 'one', title: 'Song', artist: 'Artist', cover: '' }, snapshot);
    expect(s.connected).toHaveBeenCalledOnce();
    expect(s.bridge.publish).toHaveBeenLastCalledWith(expect.objectContaining({
      track_id: 'one', title: 'Song', playing: true, position: 42, duration: 180, volume: 0.5,
    }));
    s.send();
    expect(s.controls.act).toHaveBeenCalledWith({ action: 'pause' });
    s.session.dispose();
  });
  it('retains browser controls when native media is unavailable', async () => {
    vi.useFakeTimers();
    const s = setup(false);
    await Promise.resolve();
    s.session.sync(null, snapshot);
    expect(s.session.active).toBe(false);
    expect(s.connected).not.toHaveBeenCalled();
    expect(s.bridge.publish).not.toHaveBeenCalled();
    s.session.dispose();
  });
  it('clears metadata and stops heartbeats after logout', async () => {
    vi.useFakeTimers();
    const s = setup();
    await Promise.resolve();
    s.session.dispose();
    expect(s.bridge.publish).toHaveBeenLastCalledWith(expect.objectContaining({ track_id: '', playing: false }));
    const count = vi.mocked(s.bridge.publish).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(vi.mocked(s.bridge.publish).mock.calls).toHaveLength(count);
    s.send();
    expect(s.controls.act).not.toHaveBeenCalled();
  });
  it('ignores a connection response arriving after disposal', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.session.dispose();
    await Promise.resolve();
    expect(s.session.active).toBe(false);
    expect(s.connected).not.toHaveBeenCalled();
  });
});
