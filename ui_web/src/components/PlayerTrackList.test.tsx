import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerTrackList, type PlayerTrackListCard, type PlayerTrackListSection } from './PlayerTrackList';

const layout = vi.hoisted(() => ({ mobile: false }));
vi.mock('../lib/listLayout', () => ({ mobileListLayout: () => layout.mobile }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
const menu = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: menu.open }));
afterEach(() => { cleanup(); vi.clearAllMocks(); layout.mobile = false; });

const contextCard = (over: Partial<PlayerTrackListCard> = {}): PlayerTrackListCard => ({
  id: 'context',
  title: 'Record',
  detail: 'Album · 8 tracks',
  seed: 'album:record',
  entries: [{ id: 'next', title: 'Next', artist: 'Artist', onActivate: vi.fn() }],
  menu: () => [{ label: 'Remove', onSelect: () => {} }],
  remove: { label: 'Remove Record from the queue', onSelect: vi.fn() },
  ...over,
});

const list = (sections: () => PlayerTrackListSection[]) => render(() => (
  <PlayerTrackList title="Queue" count={0} sections={sections()} empty="Nothing" />
));

describe('continuation cards', () => {
  it('expands on the card, collapses on the chevron, and keeps navigation in the menu', () => {
    const card = contextCard();
    const { container } = list(() => [{ id: 'continuation', label: 'Then', entries: [], cards: [card] }]);
    expect(container.querySelector('[data-drag-row]')).toBeNull();
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

  it('keeps an empty finite collection expandable and explains the empty pass', () => {
    const { container } = list(() => [{ id: 'continuation', entries: [], cards: [contextCard({ entries: [] })] }]);
    fireEvent.click(container.querySelector('[data-card-expand]')!);
    expect(screen.getByText('nowPlaying.contextNoUpcoming')).toBeInTheDocument();
  });

  it('retains expansion when the same collection receives rebuilt queue entries', () => {
    const [card, setCard] = createSignal(contextCard({ entries: [] }));
    const { container } = list(() => [{ id: 'continuation', entries: [], cards: [card()] }]);
    fireEvent.click(container.querySelector('[data-card-expand]')!);
    setCard(contextCard({ entries: [] }));
    expect(container.querySelector('[data-card-expand]')).toHaveAttribute('aria-expanded', 'true');
    setCard(contextCard({ seed: 'other', entries: [] }));
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

  it('gives the phone row its menu button, the way song rows carry one', () => {
    layout.mobile = true;
    const card = contextCard();
    list(() => [{ id: 'continuation', entries: [], cards: [card] }]);
    expect(screen.getByRole('button', { name: 'Remove Record from the queue' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'songRow.ariaMore: Record' }));
    expect(menu.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Record' }), undefined);
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
