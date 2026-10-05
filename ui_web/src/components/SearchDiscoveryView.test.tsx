import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { setLocale } from '../lib/i18n';
import { SearchDiscoveryView } from './SearchDiscoveryView';
import type { CatalogItem } from '../types/music';
afterEach(cleanup);
const songs: CatalogItem[] = Array.from({ length: 10 }, (_, index) => ({ id: `song:${index}`, title: `Song ${index}`, source: 'library', type: 'library_track' }));
it('keeps songs bounded on home and delegates section, entity and playback actions independently', () => {
  setLocale('en');
  const [expanded, setExpanded] = createSignal<string | undefined>();
  const openEntity = vi.fn(), play = vi.fn(), back = vi.fn();
  const view = render(() => <SearchDiscoveryView sections={[{ id: 'artists', popular: false, items: [{ id: 'artist:1', title: 'Artist', type: 'artist', source: 'deezer' }] }]}
    songs={songs} expanded={expanded()} loading={false} error={false} preparing={false} onBack={back} onRetry={vi.fn()}
    renderMore={(section, link) => <button aria-label={link.label} onClick={() => setExpanded(section)}>{link.children}</button>}
    renderEntity={(item, link) => <button aria-label={link.label} onClick={() => openEntity(item)}>{link.children}</button>}
    renderStatus={() => null} renderSong={item => <button onClick={() => play(item)}>{item.title}</button>} />);
  expect(view.queryByRole('button', { name: 'Song 5' })).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Artist' }));
  expect(openEntity).toHaveBeenCalledTimes(1); expect(play).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button', { name: /See all:.*songs/i }));
  expect(view.getByRole('button', { name: 'Song 9' })).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Artist' })).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Song 9' })); expect(play).toHaveBeenCalledWith(songs[9]);
  fireEvent.click(view.getByRole('button', { name: /Back/ })); expect(back).toHaveBeenCalledOnce();
});
it('keeps partial content visible and delegates retry without pretending that playback succeeded', () => {
  setLocale('en'); const retry = vi.fn();
  const view = render(() => <SearchDiscoveryView sections={[]} songs={[songs[0]]} loading={false} error preparing={false}
    onBack={vi.fn()} onRetry={retry} renderMore={() => null} renderEntity={() => null} renderStatus={() => null}
    renderSong={item => <span>{item.title}</span>} />);
  expect(view.getByText('Song 0')).toBeTruthy();
  fireEvent.click(view.getByRole('button', { name: 'Retry' })); expect(retry).toHaveBeenCalledOnce();
  expect(view.container.querySelector('audio')).toBeNull();
});
