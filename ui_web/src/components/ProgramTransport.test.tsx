import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import ProgramTransport from './ProgramTransport';
import type { ProgramState } from '../lib/program/runtime';
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
afterEach(cleanup);
const initial: ProgramState = { generation: 1, sequence: 1, ready: true, playWhenReady: false, errorKind: '', playing: false, state: 3, index: 1, id: 'a', title: 'Song', artist: '', items: [{ source: 'local', key: 'first', id: 'a', title: 'a', artist: '' }, { source: 'local', key: 'second', id: 'a', title: 'a', artist: '' }], queueToken: 'token', queue: ['a', 'a'], positionMs: 1000, durationMs: 30000, error: 0, errorStatus: 0, shuffle: false, repeat: 2, hasNext: true, hasPrevious: true };
it('uses native availability on the last occurrence and does not claim play before observation', async () => {
  const command = vi.fn(async () => {});
  const [state, setState] = createSignal(initial);
  render(() => <ProgramTransport state={state()} pending={false} command={command} />);
  expect((screen.getByText('common.next') as HTMLButtonElement).disabled).toBe(false);
  await fireEvent.click(screen.getByText('common.play'));
  expect(command).toHaveBeenCalledWith({ action: 'play' }); expect(screen.queryByText('common.pause')).toBeNull();
  setState({ ...initial, playing: true, playWhenReady: true, hasNext: false });
  expect(screen.getByText('common.pause')).toBeTruthy(); expect((screen.getByText('common.next') as HTMLButtonElement).disabled).toBe(true);
});
it('keeps a dragged seek across ticks but clears it on another occurrence of the same id', async () => {
  const [state, setState] = createSignal(initial);
  render(() => <ProgramTransport state={state()} pending={false} command={async () => {}} />);
  const slider = screen.getByRole('slider') as HTMLInputElement;
  await fireEvent.input(slider, { target: { value: '12000' } });
  setState({ ...initial, sequence: 2, positionMs: 2000 }); expect(slider.value).toBe('12000');
  setState({ ...initial, sequence: 3, index: 0, positionMs: 3000 }); expect(slider.value).toBe('3000');
});
it('sends explicit shuffle and repeat modes and disables controls while acceptance is pending', async () => {
  const command = vi.fn(async () => {}); const [pending, setPending] = createSignal(false);
  render(() => <ProgramTransport state={initial} pending={pending()} command={command} />);
  await fireEvent.click(screen.getByText('nowPlaying.shuffle'));
  await fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
  expect(command.mock.calls).toEqual([[{ action: 'shuffle', enabled: true }], [{ action: 'repeat', mode: 1 }]]);
  setPending(true); expect((screen.getByText('common.play') as HTMLButtonElement).disabled).toBe(true);
});

it('keeps seek when the current occurrence moves, and clears it for a replacement at the same index/id', async () => {
  const [state, setState] = createSignal(initial);
  render(() => <ProgramTransport state={state()} pending={false} command={async () => {}} />);
  const slider = screen.getByRole('slider') as HTMLInputElement;
  await fireEvent.input(slider, { target: { value: '12000' } });
  setState({ ...initial, index: 0, items: [...initial.items].reverse(), positionMs: 2000 }); expect(slider.value).toBe('12000');
  setState({ ...initial, index: 0, items: [initial.items[0]], queue: ['a'], positionMs: 0 }); expect(slider.value).toBe('0');
});

it('shows buffering without claiming audible playback and lets Pause cancel pending Play', async () => {
  const command = vi.fn(async () => {});
  render(() => <ProgramTransport state={{ ...initial, state: 2, playWhenReady: true }} pending={false} command={command} />);
  expect(screen.getByRole('status').textContent).toBe('common.loading');
  await fireEvent.click(screen.getByText('common.pause'));
  expect(command).toHaveBeenCalledWith({ action: 'pause' });
});
it('retries the retained occurrence without replacing queue or implicitly playing a paused program', async () => {
  const command = vi.fn(async () => {});
  const [state, setState] = createSignal({ ...initial, error: 2000, errorKind: 'connection' as ProgramState['errorKind'] });
  render(() => <ProgramTransport state={state()} pending={false} command={command} />);
  await fireEvent.click(screen.getByText('common.retry'));
  expect(command).toHaveBeenCalledWith({ action: 'retry', index: 1, key: 'second', queueToken: 'token' });
  expect(screen.getByText('common.play')).toBeTruthy();
  for (const errorKind of ['auth', 'permission', 'source'] as const) {
    setState({ ...state(), errorKind }); expect(screen.queryByText('common.retry')).toBeNull();
  }
});
it('shows observed preview progress and disables manual retry during the server cooldown', async () => {
  vi.useFakeTimers();
  try {
    const [state, setState] = createSignal<ProgramState>({ ...initial, state: 1, error: 2000, errorKind: 'server', items: initial.items.map(item => ({ ...item, source: 'preview' })), preview: { key: 'second', preparation: { state: 'pending', progress: 0.25 }, retryAttempt: 2, retryPending: false, retryNotBeforeMs: Date.now() + 1000 } });
    render(() => <ProgramTransport state={state()} pending={false} command={async () => {}} />);
    expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(0.25);
    expect((screen.getByText('common.retry') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-program-artwork]')?.getAttribute('style')).not.toContain('/api/static/cover');
    await vi.advanceTimersByTimeAsync(1000);
    expect((screen.getByText('common.retry') as HTMLButtonElement).disabled).toBe(false);
    setState({ ...state(), error: 0, state: 2, preview: { ...state().preview!, retryPending: true } });
    expect(screen.getByText('android.previewRetry')).toBeTruthy();
    expect(screen.queryByText('common.pause')).toBeNull();
  } finally { cleanup(); vi.useRealTimers(); }
});
it('does not offer seek for an unseekable native source even when its duration is known', () => {
  render(() => <ProgramTransport state={{ ...initial, seekable: false }} pending={false} command={async () => {}} />);
  expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true);
});
