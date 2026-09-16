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
  onOpen: vi.fn(),
  openLabel: 'Open Record',
  menu: () => [{ label: 'Remove', onSelect: () => {} }],
  remove: { label: 'Remove Record from the queue', onSelect: vi.fn() },
  ...over,
});

const list = (sections: () => PlayerTrackListSection[]) => render(() => (
  <PlayerTrackList title="Queue" count={0} sections={sections()} empty="Nothing" />
));

describe('continuation cards', () => {
  it('opens the collection, removes it, and never counts as a song', () => {
    const card = contextCard();
    const { container } = list(() => [{ id: 'continuation', label: 'Then', entries: [], cards: [card] }]);
    expect(screen.queryByText('Nothing')).toBeNull();
    expect(container.querySelector('[data-drag-row]')).toBeNull();
    expect(container.querySelector('[data-section-rows]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open Record' }));
    expect(card.onOpen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Record from the queue' }));
    expect(card.remove!.onSelect).toHaveBeenCalledOnce();

    fireEvent.contextMenu(container.querySelector('[data-queue-card="context"]')!);
    expect(menu.open).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Record', subtitle: 'Album · 8 tracks' }),
      expect.anything(),
    );
  });

  it('names a collection with no page without pretending to open it', () => {
    const { container } = list(() => [{ id: 'continuation', entries: [], cards: [contextCard({ onOpen: undefined, openLabel: undefined })] }]);
    expect(container.querySelector('[data-card-open]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Record' })).toBeNull();
    expect(screen.getByText('Record')).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Remove Record from the queue' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'songRow.ariaMore: Record' }));
    expect(menu.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Record' }), undefined);
  });
});
