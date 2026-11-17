import SavedEntities from './SavedEntities';
import { savedEntities } from '../lib/savedEntities';
import { normalizeLibraryQuery } from '../lib/librarySearch';
import { libraryTrackMusic } from '../lib/musicNavigation';
import { mobileListLayout } from '../lib/listLayout';
import { MusicListRow } from './MusicListRow';
import { openArtistMenu } from './artistActions';
import { Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { actions, isPlayingTrack } from '../stores';
import { openTrackMenu } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import SongRow from './SongRow';
import { CollectionRows } from './CollectionView';
import { EmptyState } from './EmptyState';
import { artistPath } from '../lib/artistRoute';
import { coverBackground } from '../lib/cover';
import { coverUrl, trackCoverUrl } from '../lib/media';
import { createResponsiveTap } from '../lib/responsiveTap';
import { t } from '../lib/i18n';
import type { LibrarySearchResult } from '../lib/librarySearch';
import styles from './LibrarySearchResults.module.css';
import { registerPrimaryScroll } from '../lib/scrollHistory';

function ArtistResult(props: { result: Extract<LibrarySearchResult, { kind: 'artist' }>; onOpen: () => void }) {
  const tap = createResponsiveTap({ onTap: props.onOpen });
  return (
    <Show when={!mobileListLayout()} fallback={<MusicListRow title={props.result.artist.name}
      subtitle={t('library.artistTrackCount', { count: props.result.artist.count })} seed={props.result.artist.name}
      cover={coverUrl(props.result.artist.coverId, 'thumb')} round onActivate={props.onOpen}
      onMenu={(event) => openArtistMenu(props.result.artist.name, { artistId: props.result.artist.id }, event)} />}>
    <div
      class={styles.artistRow}
      data-library-artist-row
      data-pressable
      role="button"
      tabindex="0"
      aria-label={t('library.openArtist', { artist: props.result.artist.name })}
      {...tap}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        props.onOpen();
      }}
    >
      <div
        class={styles.avatar}
        style={{ background: coverBackground(props.result.artist.name, coverUrl(props.result.artist.coverId, 'thumb')) }}
      />
      <div class={styles.artistMeta}>
        <span class={styles.artistName}>{props.result.artist.name}</span>
        <span class={styles.artistCount}>{t('library.artistTrackCount', { count: props.result.artist.count })}</span>
      </div>
      <span class={styles.badge}>{t('library.resultArtist')}</span>
      <svg class={styles.chevron} viewBox="0 0 24 24" aria-hidden="true">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </div>
    </Show>
  );
}

export default function LibrarySearchResults(props: { results: LibrarySearchResult[]; query?: string }) {
  let scrollRef: HTMLDivElement | undefined;
  const navigate = useNavigate();
  const openMenu = (track: Extract<LibrarySearchResult, { kind: 'track' }>['track'], event?: MouseEvent) =>
    openTrackMenu(
      track,
      {
        navigate,
        onAddToPlaylist: openPlaylistPicker,
        onEditMetadata: openMetadataEditor,
        onPlayOnDevice: openPlayOnDevice,
      },
      event,
    );

  return (
    <div
      ref={(element) => {
        scrollRef = element;
        registerPrimaryScroll(element);
      }}
      class={styles.scroll}
      data-library-scroll
      data-primary-scroll
    >
      <Show when={props.query}><SavedEntities query={props.query} /></Show>
      <Show when={props.results.length > 0} fallback={<Show when={!props.query || !savedEntities().some(entry => normalizeLibraryQuery(`${entry.name} ${entry.artist ?? ''}`).includes(normalizeLibraryQuery(props.query!)))}><EmptyState>{t('library.noSearchResults')}</EmptyState></Show>}>
        <CollectionRows items={props.results} scrollElement={() => scrollRef ?? null}>
          {(result) => {
            const track = () => (result() as Extract<LibrarySearchResult, { kind: 'track' }>).track;
            return (
              <>
                <Show when={result().kind === 'track'}>
                  <SongRow
                    track={track()}
                    music={libraryTrackMusic(track())}
                    // A saved song with no file has no engine-side cover to
                    // ask for; its thumbnail is the only artwork it has.
                    cover={trackCoverUrl(track(), 'thumb')}
                    badge={t('library.resultTrack')}
                    active={isPlayingTrack(track())}
                    // A search result is a song picked on its own, not a
                    // place in the results: the rest of them do not follow.
                    onPlay={(played) => actions.playTrack(played)}
                    onMenu={openMenu}
                  />
                </Show>
                <Show when={result().kind === 'artist'}>
                  <ArtistResult
                    result={result() as Extract<LibrarySearchResult, { kind: 'artist' }>}
                    onOpen={() => navigate(artistPath((result() as Extract<LibrarySearchResult, { kind: 'artist' }>).artist.name, { view: 'library' }))}
                  />
                </Show>
              </>
            );
          }}
        </CollectionRows>
      </Show>
    </div>
  );
}
