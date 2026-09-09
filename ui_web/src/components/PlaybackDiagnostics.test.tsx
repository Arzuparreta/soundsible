import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackDiagnostics } from './PlaybackDiagnostics';
import { diagnosticStatus, playbackDiagnosticExport, stopPlaybackDiagnostics } from '../lib/playbackDiagnostics';
import { setLocale } from '../lib/i18n';

const controls = vi.hoisted(() => ({ canConfigure: true, pause: vi.fn(), reset: vi.fn() }));
vi.mock('../stores', () => ({ actions: { pausePlayback: controls.pause } }));
vi.mock('../lib/audio', () => ({
  canConfigurePlaybackDiagnostics: () => controls.canConfigure,
  resetDiagnosticRetirement: controls.reset,
}));
afterEach(() => { stopPlaybackDiagnostics(); controls.canConfigure = true; vi.clearAllMocks(); });

describe('playback diagnostic controls', () => {
  it('locks configuration during capture, records human markers and stops with a pause', async () => {
    await setLocale('en');
    render(() => <PlaybackDiagnostics />);
    const start = screen.getByRole('button', { name: /Start new capture/ });
    expect(start).toBeDisabled();
    fireEvent.input(screen.getByRole('textbox', { name: 'Exact iOS version' }), { target: { value: '999' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Test' }), { target: { value: 'excluded' } });
    fireEvent.click(start);
    expect(diagnosticStatus().setup?.variant).toBe('excluded');
    expect(screen.queryByRole('combobox', { name: 'Test' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Mark volume controls failing/ }));
    expect(playbackDiagnosticExport()).toContain('human.volume_failed');
    fireEvent.click(screen.getByRole('button', { name: /Pause and finish capture/ }));
    expect(controls.pause).toHaveBeenCalledWith('ui');
    expect(diagnosticStatus().active).toBe(false);
    expect(screen.getByRole('button', { name: /Export capture/ })).toBeEnabled();
  });

  it('does not enable a new experiment while audio is playing', async () => {
    await setLocale('en');
    controls.canConfigure = false;
    render(() => <PlaybackDiagnostics />);
    fireEvent.input(screen.getByRole('textbox', { name: 'Exact iOS version' }), { target: { value: '999' } });
    expect(screen.getByRole('button', { name: /Start new capture/ })).toBeDisabled();
  });
});
