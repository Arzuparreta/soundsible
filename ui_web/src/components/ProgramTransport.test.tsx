import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import ProgramTransport from './ProgramTransport';
import type { ProgramState } from '../lib/program/runtime';
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
afterEach(cleanup);
const initial: ProgramState = { generation: 1, sequence: 1, ready: true, playing: false, state: 3, index: 1, id: 'a', title: 'Song', artist: '', items: [{ key: 'first', id: 'a', title: 'a', artist: '' }, { key: 'second', id: 'a', title: 'a', artist: '' }], queueToken: 'token', queue: ['a', 'a'], positionMs: 1000, durationMs: 30000, error: 0, errorStatus: 0, shuffle: false, repeat: 2, hasNext: true, hasPrevious: true };
it('uses native availability on the last occurrence and does not claim play before observation', async () => {
  const command = vi.fn(async () => {});
  const [state, setState] = createSignal(initial);
  render(() => <ProgramTransport state={state()} pending={false} command={command} />);
  expect((screen.getByText('common.next') as HTMLButtonElement).disabled).toBe(false);
  await fireEvent.click(screen.getByText('common.play'));
  expect(command).toHaveBeenCalledWith({ action: 'play' }); expect(screen.queryByText('common.pause')).toBeNull();
  setState({ ...initial, playing: true, hasNext: false });
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
