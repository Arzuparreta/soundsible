import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProgramQueue from './ProgramQueue';
import type { ProgramState } from '../lib/program/runtime';
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('@tanstack/solid-virtual', () => ({ createVirtualizer: (options: { count: number; getItemKey(index: number): string }) => ({ measure() {}, measureElement() {}, getTotalSize: () => options.count * 56, getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ key: options.getItemKey(index), start: index * 56 })) }) }));
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const initial: ProgramState = { generation: 1, sequence: 1, ready: true, playWhenReady: true, errorKind: '', playing: true, state: 3, index: 1, id: 'a', title: 'Song', artist: '', queue: ['a', 'a'], items: [{ source: 'local', key: 'first', id: 'a', title: 'Song', artist: '' }, { source: 'local', key: 'second', id: 'a', title: 'Song', artist: '' }], queueToken: 'first-second', positionMs: 1000, durationMs: 30000, error: 0, errorStatus: 0, shuffle: false, repeat: 2, hasNext: true, hasPrevious: true };
it('targets the selected occurrence and exposes a distinct active row for repeated ids', async () => {
  const command = vi.fn(async () => {});
  const { container } = render(() => <ProgramQueue state={initial} pending={false} command={command} />);
  const rows = container.querySelectorAll('[data-row-main]');
  expect(rows[0].getAttribute('aria-current')).toBeNull(); expect(rows[1].getAttribute('aria-current')).toBe('true');
  await fireEvent.click(rows[1]);
  expect(command).toHaveBeenCalledWith({ action: 'select', index: 1, key: 'second', queueToken: 'first-second' });
  await fireEvent.click(screen.getByText('musicExplorer.edit'));
  await fireEvent.click(container.querySelector('[data-queue-key=first] [data-queue-action=remove]')!);
  expect(command).toHaveBeenLastCalledWith({ action: 'remove', index: 0, key: 'first', queueToken: 'first-second' });
});
it('retains row and focused edit control across fresh snapshots and reorders, updating its target index', async () => {
  const [state, setState] = createSignal(initial); const command = vi.fn(async () => {});
  const { container } = render(() => <ProgramQueue state={state()} pending={false} command={command} />);
  await fireEvent.click(screen.getByText('musicExplorer.edit'));
  const control = container.querySelector('[data-queue-key=second] [data-queue-action=remove]') as HTMLButtonElement; control.focus();
  setState({ ...initial, sequence: 2, positionMs: 2000, items: initial.items.map(item => ({ ...item })) });
  expect(document.activeElement).toBe(control);
  setState({ ...initial, sequence: 3, index: 0, items: [...initial.items].reverse(), queueToken: 'second-first' }); await Promise.resolve();
  expect(document.activeElement).toBe(control); expect(control.isConnected).toBe(true);
  await fireEvent.click(control); expect(command).toHaveBeenLastCalledWith({ action: 'remove', index: 0, key: 'second', queueToken: 'second-first' });
});
it('disables boundary moves and all editing while a command is pending', async () => {
  const [pending, setPending] = createSignal(false); const command = vi.fn(async () => {});
  const { container } = render(() => <ProgramQueue state={initial} pending={pending()} command={command} />);
  await fireEvent.click(screen.getByText('musicExplorer.edit'));
  expect((container.querySelector('[data-queue-key=first] [data-queue-action=up]') as HTMLButtonElement).disabled).toBe(true);
  expect((container.querySelector('[data-queue-key=second] [data-queue-action=down]') as HTMLButtonElement).disabled).toBe(true);
  setPending(true); await fireEvent.click(container.querySelector('[data-queue-key=first] [data-row-main]')!);
  expect(command).not.toHaveBeenCalled(); expect((container.querySelector('[data-queue-action=remove]') as HTMLButtonElement).disabled).toBe(true);
});

it('removes a stale rendered row without retaining the previous occurrence', async () => {
  const [state, setState] = createSignal(initial);
  const { container } = render(() => <ProgramQueue state={state()} pending={false} command={async () => {}} />);
  setState({ ...initial, index: 0, queue: ['a'], items: [initial.items[1]], queueToken: 'second' }); await Promise.resolve();
  expect(container.querySelector('[data-queue-key=first]')).toBeNull();
  expect(container.querySelectorAll('[data-row-main]')).toHaveLength(1);
});

it('marks the cued DJ occurrence and keeps edits outside the committed pair', async () => {
  const command = vi.fn(async () => {});
  const [state, setState] = createSignal<ProgramState>({ ...initial, index: 0,
    items: [...initial.items, { ...initial.items[0], key: 'third' }], dj: { active: true, phase: 'ready', profile: 'adaptive', editableFrom: 2 } });
  const { container } = render(() => <ProgramQueue state={state()} pending={false} command={command} />);
  expect(screen.getByText('autoMode.dj.cued')).toBeTruthy();
  await fireEvent.click(screen.getByText('musicExplorer.edit'));
  const disabled = (key: string, action: string) => (container.querySelector(`[data-queue-key=${key}] [data-queue-action=${action}]`) as HTMLButtonElement).disabled;
  expect(disabled('first', 'remove')).toBe(true);
  expect(disabled('second', 'remove')).toBe(true);
  expect(disabled('third', 'up')).toBe(true);
  expect(disabled('third', 'remove')).toBe(false);
  setState({ ...state(), index: 1 });
  expect(screen.queryByText('autoMode.dj.cued')).toBeNull();
  expect(disabled('first', 'remove')).toBe(false);
});

it('opens shared actions for the selected occurrence without playing and rejects a stale removal', async () => {
  const [state, setState] = createSignal(initial); const command = vi.fn(async () => {}); const onMenu = vi.fn();
  const { container } = render(() => <ProgramQueue state={state()} pending={false} command={command} onMenu={onMenu} />);
  await fireEvent.click(container.querySelector('[data-queue-key=first] [data-row-menu]')!);
  expect(command).not.toHaveBeenCalled(); expect(onMenu.mock.calls[0][0].key).toBe('first');
  const remove = onMenu.mock.calls[0][2][0];
  expect(remove.disabled).toBe(false); remove.onSelect();
  expect(command).toHaveBeenCalledExactlyOnceWith({ action: 'remove', index: 0, key: 'first', queueToken: 'first-second' });
  for (const changed of [{ ...initial, generation: 2 }, { ...initial, programToken: 'new-owner' },
    { ...initial, items: [...initial.items].reverse(), queueToken: 'second-first' }]) {
    setState(changed); remove.onSelect();
  }
  expect(command).toHaveBeenCalledTimes(1);
});
it('allows song actions on cued DJ rows but forbids removal when a handoff becomes committed', async () => {
  const [state, setState] = createSignal<ProgramState>({ ...initial, index: 0, programToken: 'dj',
    dj: { active: true, phase: 'ready', profile: 'adaptive', editableFrom: 1 } });
  const command = vi.fn(async () => {}); const onMenu = vi.fn();
  const { container } = render(() => <ProgramQueue state={state()} pending={false} command={command} onMenu={onMenu} />);
  await fireEvent.click(container.querySelector('[data-queue-key=second] [data-row-menu]')!);
  const remove = onMenu.mock.calls[0][2][0]; expect(remove.disabled).toBe(false);
  setState({ ...state(), dj: { ...state().dj!, editableFrom: 2 } }); remove.onSelect();
  expect(command).not.toHaveBeenCalled();
  await fireEvent.click(container.querySelector('[data-queue-key=second] [data-row-menu]')!);
  expect(onMenu.mock.calls[1][2][0].disabled).toBe(true);
});

it('moves a requested block past its own bridge and locks the owner of a prepared bridge', async () => {
  const song = initial.items[0];
  const items = [{ ...song, key: 'seed' }, { ...song, key: 'filler' }, { ...song, key: 'bridge', routeOwnerKey: 'request' },
    { ...song, key: 'request' }, { ...song, key: 'last' }];
  const [state, setState] = createSignal<ProgramState>({ ...initial, index: 0, items,
    dj: { active: true, phase: 'ready', profile: 'adaptive', editableFrom: 1, protectedKeys: ['seed'] } });
  const command = vi.fn(async () => {}); const onMenu = vi.fn();
  const { container } = render(() => <ProgramQueue state={state()} pending={false} command={command} onMenu={onMenu} />);
  await fireEvent.click(screen.getByText('musicExplorer.edit'));
  await fireEvent.click(container.querySelector('[data-queue-key=request] [data-queue-action=up]')!);
  expect(command).toHaveBeenLastCalledWith({ action: 'move', index: 3, key: 'request', queueToken: initial.queueToken, toIndex: 1 });
  setState({ ...state(), index: 1, dj: { ...state().dj!, editableFrom: 4, protectedKeys: ['filler', 'bridge', 'request'] } });
  expect((container.querySelector('[data-queue-key=request] [data-queue-action=remove]') as HTMLButtonElement).disabled).toBe(true);
  await fireEvent.click(container.querySelector('[data-queue-key=request] [data-row-menu]')!);
  expect(onMenu.mock.calls[0][2][0].disabled).toBe(true);
});
it('clears only upcoming requests and marks where the playing context continues', async () => {
  const command = vi.fn(async () => {});
  const lanes: ProgramState = { ...initial, index: 0, queue: ['a', 'r1', 'r2', 'c'], items: [
    { source: 'local', key: 'now', id: 'a', title: 'Now', artist: '', lane: 'context' },
    { source: 'local', key: 'r1', id: 'r1', title: 'Request one', artist: '', lane: 'manual' },
    { source: 'local', key: 'r2', id: 'r2', title: 'Request two', artist: '', lane: 'manual' },
    { source: 'local', key: 'c', id: 'c', title: 'Album next', artist: '', lane: 'context' },
  ] };
  const [state, setState] = createSignal(lanes);
  render(() => <ProgramQueue state={state()} pending={false} command={command} />);
  expect(screen.getByText('nowPlaying.continuationSection')).toBeVisible();
  await fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.clearManualQueue' }));
  expect(command).toHaveBeenCalledWith({ action: 'clearManual', queueToken: lanes.queueToken });
  setState({ ...lanes, queue: ['a', 'c'], items: [lanes.items[0], lanes.items[3]] });
  expect(screen.queryByRole('button', { name: 'nowPlaying.clearManualQueue' })).toBeNull();
  expect(screen.queryByText('nowPlaying.continuationSection')).toBeNull();
});
