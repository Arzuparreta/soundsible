import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticRetirement } from './diagnosticRetirement';
import { playbackDiagnosticExport, startPlaybackDiagnostics, stopPlaybackDiagnostics } from '../playbackDiagnostics';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { stopPlaybackDiagnostics(); vi.useRealTimers(); });
function fixture() {
  startPlaybackDiagnostics({ variant: 'delayed', ios: '999', connection: 'bluetooth' });
  return new DiagnosticRetirement();
}

describe('experimental retirement lifetime', () => {
  it('does not delay the reference or a graphless output', () => {
    const release = vi.fn();
    new DiagnosticRetirement().retire(release, true);
    expect(release).toHaveBeenCalledTimes(1);
    fixture().retire(release, false);
    expect(release).toHaveBeenCalledTimes(2);
    expect(playbackDiagnosticExport()).toContain('retirement.delay_unavailable');
  });

  it('holds reuse until retirement and runs only the latest preload request', () => {
    const retirement = fixture();
    const release = vi.fn(), old = vi.fn(), next = vi.fn();
    retirement.retire(release, true);
    retirement.defer(old);
    retirement.defer(next);
    vi.advanceTimersByTime(7999);
    expect(release).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(old).not.toHaveBeenCalled();
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(next.mock.invocationCallOrder[0]);
  });

  it('cannot pause a reused deck or restart work after transport cancellation', () => {
    const retirement = fixture();
    const release = vi.fn(), next = vi.fn();
    retirement.retire(release, true);
    retirement.defer(next);
    retirement.flush('transport_pause');
    vi.advanceTimersByTime(9000);
    expect(release).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(playbackDiagnosticExport()).toContain('transport_pause');
  });

  it('does not replace a committed transition with preload and cancels its owner on abort', () => {
    const retirement = fixture();
    const next = vi.fn(), cancelled = vi.fn(), preload = vi.fn();
    retirement.retire(vi.fn(), true);
    retirement.defer(next, cancelled);
    retirement.defer(preload);
    expect(cancelled).not.toHaveBeenCalled();
    retirement.flush('transport_pause');
    expect(cancelled).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(9000);
    expect(next).not.toHaveBeenCalled();
    expect(preload).not.toHaveBeenCalled();
  });

  it('uses media events to finish a throttled timer and records the real delay', () => {
    const retirement = fixture();
    const release = vi.fn();
    retirement.retire(release, true);
    vi.spyOn(performance, 'now').mockReturnValue(12000);
    retirement.tick();
    expect(release).toHaveBeenCalledTimes(1);
    expect(playbackDiagnosticExport()).toContain('media_clock');
    vi.restoreAllMocks();
  });
});
