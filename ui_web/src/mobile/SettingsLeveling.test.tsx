import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import NativeSettingsLeveling from './SettingsLeveling';
import type { ProgramState } from '../lib/program/runtime';
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
type State = Pick<ProgramState, 'ready' | 'leveling'>;
it('reads the service preference before first Play and does not poll on unrelated programme observations', async () => {
  const [state, setState] = createSignal<State>({ ready: true, leveling: { enabled: null, settingsPhase: 'idle' } });
  const command = vi.fn().mockResolvedValue(undefined);
  render(() => <NativeSettingsLeveling state={state()} pending={false} available={true} command={command} />);
  expect(command).toHaveBeenCalledWith({ action: 'leveling', enabled: true, reload: true }); expect(screen.queryByRole('switch')).toBeNull();
  for (let i = 0; i < 5; i++) setState({ ...state() });
  expect(command).toHaveBeenCalledOnce();
  setState({ ready: true, leveling: { enabled: false, settingsPhase: 'ready' } });
  await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
});
it('keeps the confirmed preference until the service confirms a change', async () => {
  const [state, setState] = createSignal<State>({ ready: true, leveling: { enabled: false, settingsPhase: 'ready' } });
  const command = vi.fn().mockResolvedValue(undefined);
  render(() => <NativeSettingsLeveling state={state()} pending={false} available={true} command={command} />);
  await fireEvent.click(screen.getByRole('switch'));
  expect(command).toHaveBeenCalledWith({ action: 'leveling', enabled: true, reload: false });
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  setState({ ready: true, leveling: { enabled: false, settingsPhase: 'loading' } }); expect(screen.queryByRole('switch')).toBeNull();
  setState({ ready: true, leveling: { enabled: true, settingsPhase: 'ready' } }); expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
});
it('does not treat an offline cached value or failed read as an editable default', async () => {
  const [available, setAvailable] = createSignal(false), [state, setState] = createSignal<State>({ ready: true, leveling: { enabled: false, settingsPhase: 'cached' } });
  const command = vi.fn().mockResolvedValue(undefined);
  render(() => <NativeSettingsLeveling state={state()} pending={false} available={available()} command={command} />);
  expect(command).not.toHaveBeenCalled(); expect(screen.queryByRole('switch')).toBeNull(); expect(screen.getByRole('status')).toHaveTextContent('library.unreachable');
  setState({ ready: true, leveling: { enabled: null, settingsPhase: 'unavailable' } }); setAvailable(true);
  expect(command).not.toHaveBeenCalled(); await fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
  expect(command).toHaveBeenCalledWith({ action: 'leveling', enabled: true, reload: true });
});
