import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtistLinks, AlbumLink } from './MusicLinks';
import { MusicListRow } from './MusicListRow';
import { albumMusic, catalogMusic, registerMusicNavigator, trackMusic } from '../lib/musicNavigation';
import { state, setNowPlayingOpen, nowPlayingOpen } from '../stores';
import { buildTrackMenu } from './trackActions';

const navigate = vi.fn();
let unregister: () => void;
beforeEach(() => { unregister = registerMusicNavigator(navigate); navigate.mockClear(); setNowPlayingOpen(false); });
afterEach(() => { cleanup(); unregister(); });

describe('music navigation', () => {
  it('links each structured performer without splitting actual artist names', () => {
    render(() => <ArtistLinks music={{ artist: 'Björk & AC/DC', artists: ['Björk', 'AC/DC'], view: 'discover' }} />);
    expect(screen.getByRole('link', { name: 'AC/DC' })).toHaveAttribute('href', '#/artist/AC%2FDC?view=discover');
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('keeps an unstructured band name whole, and carries provider identity', () => {
    render(() => <ArtistLinks music={catalogMusic({ id: 'song', type: 'track', source: 'deezer',
      title: 'Song', artist: 'Earth, Wind & Fire', external_ids: { deezer_artist_id: 42 } })} />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link')).toHaveAttribute('href', '#/artist/Earth%2C%20Wind%20%26%20Fire?view=discover&deezer_id=42');
  });

  it('navigates independently from playback and closes Now Playing without changing its session', () => {
    const play = vi.fn(); const menu = vi.fn();
    const playback = JSON.stringify(state.playback); const auto = JSON.stringify(state.autoMode);
    setNowPlayingOpen(true);
    const { container } = render(() => <MusicListRow title="Song" subtitle="Artist" seed="song"
      music={{ artist: 'Artist', view: 'library' }} onActivate={play} onMenu={menu} />);
    expect(container.querySelector('button a, a a, [role="button"] a')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Artist' }));
    expect(navigate).toHaveBeenCalledWith('/artist/Artist?view=library');
    expect(nowPlayingOpen()).toBe(false);
    expect(play).not.toHaveBeenCalled(); expect(menu).not.toHaveBeenCalled();
    expect(JSON.stringify(state.playback)).toBe(playback); expect(JSON.stringify(state.autoMode)).toBe(auto);
    fireEvent.click(screen.getByRole('button', { name: 'Song — Artist' }));
    expect(play).toHaveBeenCalledOnce();
  });

  it('leaves modified and middle clicks to the browser without closing the player', () => {
    setNowPlayingOpen(true);
    render(() => <ArtistLinks music={{ artist: 'Artist', view: 'discover' }} />);
    const link = screen.getByRole('link');
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    fireEvent.click(link, { button: 1 });
    expect(navigate).not.toHaveBeenCalled(); expect(nowPlayingOpen()).toBe(true);
  });

  it('does not turn podcast authors, uploaders or missing metadata into music links', () => {
    render(() => <>
      <ArtistLinks music={trackMusic({ id: 'p', title: 'Episode', artist: 'Author', media_kind: 'podcast_episode' })} />
      <ArtistLinks music={trackMusic({ id: 'y', title: 'Video', artist: 'Uploader', artist_is_channel: true })} />
      <ArtistLinks music={{ artist: '', view: 'library' }} />
      <AlbumLink music={{ album: '', view: 'library' }} />
    </>);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('keeps homonymous album identities distinct and matches menu destinations', () => {
    const music = albumMusic({ id: 'queen-hits', title: 'Greatest Hits', album_artist: 'Queen', album_artist_id: 'queen',
      is_compilation: false, duration: 200, track_count: 1 });
    render(() => <><AlbumLink music={music} /><ArtistLinks music={music} /></>);
    const album = screen.getByRole('link', { name: 'Greatest Hits' });
    expect(album).toHaveAttribute('href', '#/album/Greatest%20Hits?artist=Queen&view=library&album_id=queen-hits');
    expect(screen.getByRole('link', { name: 'Queen' })).toHaveAttribute('href', '#/artist/Queen?view=library&artist_id=queen');
    const menu = buildTrackMenu({ id: 'song', title: 'Song', artist: 'Queen', album: 'Greatest Hits' }, { music });
    // The album action is the only navigation entry whose path contains album_id.
    for (const action of menu.filter((entry) => /album|álbum/i.test(entry.label))) action.onSelect?.();
    expect(navigate).toHaveBeenCalledWith(album.getAttribute('href')!.slice(1));
  });
});
