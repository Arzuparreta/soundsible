import { beforeEach, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@solidjs/testing-library';
import { offlineActions, openOfflineManager } from './OfflineManager';
import { openContextMenu, ContextMenuOutlet } from '../lib/contextMenu';
import { OverlayOutlet } from '../lib/overlay';
import { ActionMenuList } from '../components/ActionMenu';
import { setLocale } from '../lib/i18n';
import type { OfflineState } from './offline';
const track = { id: 'one', title: 'One', artist: 'Artist' };
const state: OfflineState = { items: [], user: null, usedBytes: 0, limitBytes: 1000, playlists: {} };
beforeEach(() => { cleanup(); setLocale('en'); });
it('prepares only acquired members from a collection menu and guards account changes', () => {
  let generation = 1;
  const execute = vi.fn(async () => {});
  const actions = offlineActions([track, track, { ...track, id: 'A1111111111', source: 'preview' }], () => state, execute, () => generation);
  const menu = render(() => <ActionMenuList opts={{ actions }} close={() => {}} />);
  fireEvent.click(menu.getByText('Available offline'));
  expect(execute).toHaveBeenCalledWith({ action: 'prepare', tracks: [track, track], playlists: {} });
  generation++;
  actions[0].onSelect(); expect(execute).toHaveBeenCalledTimes(1);
});
it('retains explicit ready copies and exposes removal inside the menu', () => {
  const execute = vi.fn(async () => {});
  const ready: OfflineState = { ...state, items: [{ track, state: 'ready', bytes: 100, total: 100, error: '' }] };
  const actions = offlineActions([track], () => ready, execute, () => 1);
  expect(actions[0]).toMatchObject({ selected: true, disabled: true });
  actions[1].onSelect(); expect(execute).toHaveBeenCalledWith({ action: 'remove', ids: ['one'] });
});

it('selection executes after the actual overlay closes', () => {
  const execute = vi.fn(async () => {});
  render(() => <><OverlayOutlet /><ContextMenuOutlet /></>);
  openContextMenu({ title: 'Playlist', actions: offlineActions([track], () => state, execute, () => 1) });
  fireEvent.click(screen.getByText('Available offline'));
  expect(execute).toHaveBeenCalledTimes(1);
});
it('opens the manager from a library action sheet after disposing that sheet', async () => {
  render(() => <><OverlayOutlet /><ContextMenuOutlet /></>);
  openContextMenu({ title: 'Library', actions: [{ label: 'Manage offline music', onSelect: () => openOfflineManager(() => state, vi.fn()) }] });
  fireEvent.click(screen.getByRole('button', { name: 'Manage offline music' }));
  await Promise.resolve();
  expect(screen.getByTestId('android-offline-manager')).toBeTruthy();
});
it('a failed removal keeps a removal action without retrying preparation of the retired source', () => {
  const execute = vi.fn(async () => {});
  const failed: OfflineState = { ...state, items: [{ track, state: 'error', bytes: 100, total: 100, error: 'storage' }] };
  render(() => <OverlayOutlet />);
  openOfflineManager(() => failed, execute);
  expect(screen.getByText('Could not remove the copy. Try again.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Remove from this device' }));
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'remove', ids: ['one'] });
});
it('renders unknown-length preparation without assigning a non-finite native progress value', () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLProgressElement.prototype, 'value')!.set!;
  const values: number[] = [];
  const guard = vi.spyOn(HTMLProgressElement.prototype, 'value', 'set').mockImplementation(function (this: HTMLProgressElement, value: number) {
    if (!Number.isFinite(Number(value))) throw new TypeError('Non-finite progress value');
    values.push(value); setter.call(this, value);
  });
  try {
    render(() => <OverlayOutlet />);
    openOfflineManager(() => ({ ...state, items: [{ track, state: 'queued', bytes: 0, total: 0, error: '' }] }), vi.fn());
    expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
    expect(values).toEqual([]);
  } finally { guard.mockRestore(); }
});
