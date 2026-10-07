import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import NativeSettingsPlayback from './SettingsPlayback';
import type { ProgramState } from '../lib/program/runtime';
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const initial: ProgramState = { generation: 1, sequence: 1, ready: true, playWhenReady: false, errorKind: '', playing: false, state: 3, index: 0, id: 'a', title: 'Song', artist: '', items: [], queueToken: 'token', queue: [], positionMs: 0, durationMs: 30000, error: 0, errorStatus: 0, shuffle: false, repeat: 0, hasNext: false, hasPrevious: false,
  autoplay: { enabled: false, settingsPhase: 'ready', active: false, phase: 'idle' } };
it('waits for the service preference and disables duplicate changes while it confirms', async () => {
  const [state, setState] = createSignal(initial); let deliver!: () => void;
  const command = vi.fn((command: { action: string }) => { if (command.action !== 'autoplay') return Promise.resolve(); setState({ ...initial, autoplay: { ...initial.autoplay!, settingsPhase: 'loading' } }); return new Promise<void>(done => { deliver = () => { setState({ ...initial, autoplay: { ...initial.autoplay!, enabled: true } }); done(); }; }); });
  render(() => <NativeSettingsPlayback state={state()} pending={false} available={true} command={command} />);
  const row = screen.getByRole('switch'); expect(row).toHaveAttribute('aria-checked', 'false'); await fireEvent.click(row);
  expect(command).toHaveBeenCalledWith({ action: 'autoplay', enabled: true, reload: false }); expect(screen.queryByRole('switch')).toBeNull();
  deliver(); await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
});
it('does not expose an editable unknown default and reloads through the native service', async () => {
  const command = vi.fn().mockResolvedValue(undefined);
  render(() => <NativeSettingsPlayback state={{ ...initial, autoplay: { ...initial.autoplay!, enabled: null, settingsPhase: 'unavailable' } }} pending={false} available={true} command={command} />);
  expect(screen.queryByRole('switch')).toBeNull(); await fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
  expect(command).toHaveBeenCalledWith({ action: 'autoplay', enabled: true, reload: true });
});
