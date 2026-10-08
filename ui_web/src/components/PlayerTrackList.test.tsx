import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerTrackList, type PlayerTrackListCard, type PlayerTrackListSection } from './PlayerTrackList';
import { responsiveTapConstants } from '../lib/responsiveTap';

const layout = vi.hoisted(() => ({ mobile: false }));
vi.mock('../lib/listLayout', () => ({ mobileListLayout: () => layout.mobile }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
const menu = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: menu.open }));
afterEach(() => { cleanup(); vi.clearAllMocks(); layout.mobile = false; });

const songs = (count: number) => {
  const entries = Array.from({ length: count }, (_, index) => ({ id: `song-${index + 1}`, title: `Song ${index + 1}`, artist: 'Artist', onActivate: vi.fn() }));
  return { count, rows: vi.fn((limit: number) => entries.slice(0, limit)) };
};

const contextCard = (over: Partial<PlayerTrackListCard> = {}): PlayerTrackListCard => ({
  id: 'context',
  title: 'Record',
  detail: 'Album · 8 tracks',
  seed: 'album:record',
  songs: songs(1),
  menu: () => [{ label: 'Remove', onSelect: () => {} }],
  remove: { label: 'Remove Record from the queue', onSelect: vi.fn() },
  ...over,
});

const list = (sections: () => PlayerTrackListSection[]) => render(() => (
  <PlayerTrackList title="Queue" count={0} sections={sections()} empty="Nothing" />
));

function touch(node: Element, type: string) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 20, clientY: 20, button: 0 });
  fireEvent(node, event);
}

describe('continuation cards', () => {
  it('expands on the card, collapses on the chevron, and keeps navigation in the menu', () => {
    const card = contextCard();
    const { container } = list(() => [{ id: 'continuation', label: 'Then', entries: [], cards: [card] }]);
    expect(container.querySelector('[data-drag-row]')).toBeNull();
    expect(card.songs!.rows).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('[data-card-expand]')!);
    expect(container.querySelector('[data-card-expand]')).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('[data-card-songs]')).toBeInTheDocument();
    const controls = container.querySelectorAll('[aria-expanded]');
    fireEvent.click(controls[1]);
    expect(container.querySelector('[data-card-songs]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Record from the queue' }));
    expect(card.remove!.onSelect).toHaveBeenCalledOnce();
    fireEvent.contextMenu(container.querySelector('[data-queue-card="context"]')!);
    expect(menu.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Record' }), expect.anything());
  });

  it('shows twelve songs at a time and starts over when collapsed', () => {
    const { container } = list(() => [{ id: 'continuation', entries: [], cards: [contextCard({ songs: songs(30) })] }]);
    const rows = () => container.querySelectorAll('[data-card-songs] [data-drag-row]');
    const expand = container.querySelector('[data-card-expand]')!;
    fireEvent.click(expand);
    expect(rows()).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.contextShowMore' }));
    expect(rows()).toHaveLength(24);
    fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.contextShowMore' }));
    expect(rows()).toHaveLength(30);
    expect(screen.queryByRole('button', { name: 'nowPlaying.contextShowMore' })).toBeNull();
    fireEvent.click(expand);
    fireEvent.click(expand);
    expect(rows()).toHaveLength(12);
  });

  it('shows the next page when the last song shown is moved down past it', () => {
    layout.mobile = true;
    const card = contextCard({ songs: songs(30) });
    const onMove = vi.fn();
    const rows = card.songs!.rows;
    card.songs!.rows = (limit) => rows(limit).map(row => ({ ...row, onMove, canMoveUp: true, canMoveDown: true }));
    const { container } = list(() => [{ id: 'continuation', entries: [], cards: [card] }]);
    fireEvent.click(container.querySelector('[data-card-expand]')!);
    fireEvent.click(screen.getByRole('button', { name: 'songRow.ariaMore: Song 12' }));
    const [{ actions }] = menu.open.mock.lastCall!;
    actions.find((action: { label: string }) => action.label === 'musicList.move').onSelect();
    fireEvent.click(container.querySelector('[data-drag-row="song-12"] [data-edit-command="down"]')!);
    expect(onMove).toHaveBeenCalledWith(1);
    expect(container.querySelectorAll('[data-card-songs] [data-drag-row]')).toHaveLength(24);
    expect(container.querySelector('[data-drag-row="song-12"] [data-edit-command="done"]')).toBeInTheDocument();
  });

  it('opens the page of a collection that does not expand, without claiming to expand', () => {
    const onOpen = vi.fn();
    const card = contextCard({ songs: undefined, onOpen, openLabel: 'Open Library' });
    const { container } = list(() => [{ id: 'continuation', entries: [], cards: [card] }]);
    expect(container.querySelector('[aria-expanded]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Library' }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-card-songs]')).toBeNull();
  });

  it('keeps an empty finite collection expandable and explains the empty pass', () => {
    const { container } = list(() => [{ id: 'continuation', entries: [], cards: [contextCard({ songs: songs(0) })] }]);
    fireEvent.click(container.querySelector('[data-card-expand]')!);
    expect(screen.getByText('nowPlaying.contextNoUpcoming')).toBeInTheDocument();
  });

  it('keeps expansion and the songs shown when the same collection is rebuilt', () => {
    const [card, setCard] = createSignal(contextCard({ songs: songs(30) }));
    const { container } = list(() => [{ id: 'continuation', entries: [], cards: [card()] }]);
    fireEvent.click(container.querySelector('[data-card-expand]')!);
    fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.contextShowMore' }));
    const header = container.querySelector('[data-queue-card="context"]')!;
    setCard(contextCard({ detail: 'Album · 29 tracks', songs: songs(29) }));
    expect(container.querySelector('[data-queue-card="context"]')).toBe(header);
    expect(header).toHaveTextContent('Album · 29 tracks');
    expect(container.querySelector('[data-card-expand]')).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelectorAll('[data-card-songs] [data-drag-row]')).toHaveLength(24);
    setCard(contextCard({ seed: 'other', songs: songs(30) }));
    expect(container.querySelector('[data-card-expand]')).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a switched-off card quiet but fully operable', () => {
    const [enabled, setEnabled] = createSignal(false);
    const onChange = vi.fn(() => setEnabled(!enabled()));
    const { container } = list(() => [{
      id: 'continuation',
      entries: [],
      cards: [{
        id: 'autoplay',
        title: 'Autoplay',
        detail: enabled() ? 'On' : 'Off',
        seed: 'autoplay',
        dimmed: !enabled(),
        toggle: { label: 'Autoplay', checked: enabled(), onChange },
      }],
    }]);
    const card = container.querySelector('[data-queue-card="autoplay"]')!;
    expect(card.querySelector('[aria-expanded]')).toBeNull();
    const toggle = screen.getByRole('switch', { name: 'Autoplay' });
    expect(card).toHaveAttribute('data-dimmed');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).not.toBeDisabled();
    expect(screen.getByText('Off')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledOnce();
    expect(screen.getByRole('switch', { name: 'Autoplay' })).toHaveAttribute('aria-checked', 'true');
    expect(container.querySelector('[data-queue-card="autoplay"]')).not.toHaveAttribute('data-dimmed');
    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('leaves the phone row its name: holding the card opens its menu', () => {
    vi.useFakeTimers();
    try {
      layout.mobile = true;
      const card = contextCard();
      const { container } = list(() => [{ id: 'continuation', entries: [], cards: [card] }]);
      expect(screen.getByRole('button', { name: 'Remove Record from the queue' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'songRow.ariaMore: Record' })).toBeNull();
      const target = container.querySelector('[data-card-expand]')!;
      touch(target, 'pointerdown');
      vi.advanceTimersByTime(responsiveTapConstants.LONG_PRESS_MS);
      touch(target, 'pointerup');
      expect(menu.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Record' }), undefined);
      expect(target).toHaveAttribute('aria-expanded', 'false');
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('song menus', () => {
  it.each([false, true])('exposes collection actions without playing or carrying songs (mobile: %s)', (mobile) => {
    layout.mobile = mobile;
    const activate = vi.fn();
    const carry = vi.fn();
    const { container } = list(() => [{ id: 'songs', entries: [
      { id: 'next', title: 'Next', artist: 'Artist', onActivate: activate, onCarry: carry,
        menu: () => [{ label: 'Download', onSelect: vi.fn() }] },
      { id: 'current', title: 'Current', artist: 'Artist', current: true,
        menu: () => [{ label: 'Add to playlist', onSelect: vi.fn() }] },
      { id: 'cued', title: 'Cued', artist: 'Artist', locked: true,
        menu: () => [{ label: 'Save', onSelect: vi.fn() }] },
    ] }]);
    for (const title of ['Next', 'Current', 'Cued']) {
      fireEvent.click(screen.getByRole('button', { name: `songRow.ariaMore: ${title}` }));
      expect(menu.open).toHaveBeenLastCalledWith(expect.objectContaining({ title }));
    }
    expect(container.querySelectorAll('[data-row-menu]')).toHaveLength(3);
    expect(activate).not.toHaveBeenCalled();
    expect(carry).not.toHaveBeenCalled();
  });
});
