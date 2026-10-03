import { beforeEach, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@solidjs/testing-library';
import { offlineActions } from './OfflineManager';
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
