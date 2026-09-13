import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MusicListRow } from './MusicListRow';
import { PlayerTrackList } from './PlayerTrackList';

vi.mock('../lib/listLayout', () => ({ mobileListLayout: () => true }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
const menu = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: menu.open }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('content-first mobile rows', () => {
  it('keeps action buttons separate and gives the menu the full title', () => {
    const play = vi.fn(); const open = vi.fn();
    const { container } = render(() => <MusicListRow title="A long title" subtitle="Artist" seed="a" onActivate={play} onMenu={open} />);
    expect(container.querySelector('button button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'songRow.ariaMore: A long title' }));
    expect(open).toHaveBeenCalledOnce(); expect(play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'A long title — Artist' }));
    expect(play).toHaveBeenCalledOnce();
  });

  it('acknowledges playback before resolution without declaring the song current', () => {
    let row: Element;
    const play = vi.fn(() => {
      expect(row).toHaveAttribute('data-playback-selected');
      expect(row.querySelector('[data-row-main]')).not.toHaveAttribute('aria-current');
    });
    const { container } = render(() => <MusicListRow playback title="Pending" seed="pending" onActivate={play} onMenu={() => {}} />);
    row = container.querySelector('[data-music-list-row]')!;
    fireEvent.click(row.querySelector('[data-row-menu]')!);
    expect(row).not.toHaveAttribute('data-playback-selected');
    fireEvent.click(row.querySelector('[data-row-main]')!);
    expect(play).toHaveBeenCalledOnce();
    expect(row).toHaveAttribute('data-playback-selected');
  });

  it('suppresses redundant favourites and lets active work take precedence without another control', () => {
    const [known, setKnown] = createSignal(false); const [busy, setBusy] = createSignal(false);
    const { container } = render(() => <MusicListRow title="Song" seed="a" favourite favouritesKnown={known()} busy={busy()} />);
    expect(container.querySelector('[data-row-favourite]')).not.toBeNull();
    setKnown(true); expect(container.querySelector('[data-row-favourite]')).toBeNull();
    setKnown(false); setBusy(true);
    expect(container.querySelector('[data-row-favourite]')).toBeNull();
    expect(container.querySelector('[data-row-busy]')).not.toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(1);
    setBusy(false); expect(container.querySelector('[data-row-favourite]')).not.toBeNull();
  });

  it('leaves menus available for non-activatable rows and supports the context-menu key', () => {
    const play = vi.fn(); const open = vi.fn();
    render(() => <MusicListRow title="Current" seed="a" disabled active onActivate={play} onMenu={open} />);
    const main = screen.getByRole('button', { name: 'Current' });
    fireEvent.click(main); expect(play).not.toHaveBeenCalled();
    fireEvent.keyDown(main, { key: 'F10', shiftKey: true });
    expect(open).toHaveBeenCalledOnce();
    expect(main).toHaveAttribute('aria-current', 'true');
  });

  it('opens the menu for the correct occurrence and enters explicit move mode', () => {
    const firstRemove = vi.fn(); const secondRemove = vi.fn(); const move = vi.fn();
    const { container } = render(() => <PlayerTrackList title="Queue" count={2} empty="Empty" sections={[{ id: 'queue', entries: [
      { id: 'first', title: 'Repeated song', artist: 'Artist', menu: () => [{ label: 'Remove', onSelect: firstRemove }] },
      { id: 'second', title: 'Repeated song', artist: 'Artist', onMove: move, canMoveUp: true,
        menu: () => [{ label: 'Remove', onSelect: secondRemove }] },
    ] }]} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'songRow.ariaMore: Repeated song' })[1]);
    const options = menu.open.mock.calls[0][0];
    options.actions.find((action: { label: string }) => action.label === 'Remove').onSelect();
    expect(secondRemove).toHaveBeenCalledOnce(); expect(firstRemove).not.toHaveBeenCalled();
    options.actions.find((action: { label: string }) => action.label === 'musicList.move').onSelect();
    expect(container.querySelector('[data-editing]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'musicList.moveUp' })); expect(move).toHaveBeenCalledWith(-1);
    expect(screen.getByRole('button', { name: 'musicList.moveDown' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'musicList.done' }));
    expect(container.querySelector('[data-editing]')).toBeNull();
  });

  it('keeps editing and keyboard focus on the occurrence after the queue rebuilds its rows', async () => {
    const [order, setOrder] = createSignal(['a', 'b', 'c']);
    const { container } = render(() => <PlayerTrackList title="Queue" count={3} empty="Empty" sections={[{
      id: 'queue', entries: order().map((id, index) => ({
        id, title: id, artist: 'Artist', canMoveUp: index > 0, canMoveDown: index < order().length - 1,
        onMove: (direction: -1 | 1) => setOrder((items) => {
          const next = [...items]; next.splice(index, 1); next.splice(index + direction, 0, id); return next;
        }),
      })),
    }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'songRow.ariaMore: b' }));
    menu.open.mock.calls[0][0].actions[0].onSelect();
    fireEvent.click(screen.getByRole('button', { name: 'musicList.moveUp' }));
    await Promise.resolve();
    expect(order()).toEqual(['b', 'a', 'c']);
    expect(container.querySelector('[data-drag-row="b"] [data-editing]')).not.toBeNull();
    expect(document.activeElement).toHaveAttribute('data-edit-command', 'down');
    fireEvent.click(screen.getByRole('button', { name: 'musicList.moveDown' }));
    expect(order()).toEqual(['a', 'b', 'c']);
    expect(container.querySelector('[data-drag-row="b"] [data-editing]')).not.toBeNull();
  });
});
