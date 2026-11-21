import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { setLocale } from '../lib/i18n';
import type { CatalogItem } from '../types/music';

const mocks = vi.hoisted(() => ({
  mobile: false,
  openEntryMenu: vi.fn(),
}));

vi.mock('../lib/listLayout', () => ({
  mobileListLayout: () => mocks.mobile,
}));
vi.mock('./entryActions', () => ({
  openEntryMenu: mocks.openEntryMenu,
}));
vi.mock('./MusicLinks', () => ({
  ArtistLinks: (props: { fallback?: string }) => <span>{props.fallback}</span>,
}));
vi.mock('../stores', async () => {
  const { identityMock } = await import('../lib/identityMock');
  const library: never[] = [];
  return {
    musicLibrary: () => library,
    state: {
      library,
      saved: [],
      downloads: { queue: [] },
      favourites: [],
      playback: { currentTrack: null, queue: [], isLoading: false },
    },
    ...identityMock({ currentTrack: () => null, library: () => library }),
    actions: {},
  };
});

import { CatalogResultRow } from './CatalogResultRow';

const item: CatalogItem = {
  id: 'deezer:300',
  title: 'Midnight City',
  artist: 'M83',
  source: 'deezer',
  type: 'track',
  duration: 243,
  external_ids: { deezer_id: '300' },
  raw: {
    recommendation: {
      identity: 'music:deezer:300',
      source: 'discover',
      reason: 'Related to music in your library.',
    },
  },
};

beforeEach(() => {
  mocks.mobile = false;
  setLocale('en');
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

it('renders a desktop overflow menu button with recommendation callbacks and does not trigger row play', () => {
  const onPlay = vi.fn();
  const onDownload = vi.fn();
  const onNotInterested = vi.fn();
  const onUndoNotInterested = vi.fn();

  const view = render(() => (
    <CatalogResultRow
      item={item}
      onPlay={onPlay}
      onDownload={onDownload}
      onNotInterested={onNotInterested}
      onUndoNotInterested={onUndoNotInterested}
    />
  ));

  const menuButton = view.getByRole('button', { name: 'More options: Midnight City' });
  expect(menuButton.hasAttribute('data-row-menu')).toBe(true);
  fireEvent.click(menuButton);

  expect(onPlay).not.toHaveBeenCalled();
  expect(mocks.openEntryMenu).toHaveBeenCalledTimes(1);
  expect(mocks.openEntryMenu.mock.calls[0][1]).toEqual(expect.objectContaining({
    item,
    recommendation: item.raw?.recommendation,
    onDownload,
    onNotInterested,
    onUndoNotInterested,
  }));
});

it('opens the row menu from desktop contextmenu and keyboard ContextMenu / Shift+F10', () => {
  const view = render(() => (
    <CatalogResultRow item={item} onPlay={vi.fn()} onDownload={vi.fn()} />
  ));

  fireEvent.contextMenu(view.container.querySelector('[data-catalog-row]')!);
  const titleBtn = view.getByRole('button', { name: 'Midnight City' });
  fireEvent.keyDown(titleBtn, { key: 'F10', shiftKey: true });
  fireEvent.keyDown(titleBtn, { key: 'ContextMenu' });

  expect(mocks.openEntryMenu).toHaveBeenCalledTimes(3);
});

it('renders the mobile list row variant with its more-options trigger', () => {
  mocks.mobile = true;
  const view = render(() => (
    <CatalogResultRow item={item} onPlay={vi.fn()} onDownload={vi.fn()} />
  ));

  expect(view.container.querySelector('[data-catalog-row]')).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'More options: Midnight City' }));
  expect(mocks.openEntryMenu).toHaveBeenCalledTimes(1);
});
