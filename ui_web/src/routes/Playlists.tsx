import { NoCollectionMatches, createCollectionSearch } from '../components/CollectionSearch';
import { collectionIndex } from '../lib/collectionIdentity';
import { SkeletonCards } from '../components/Skeleton';
import { NEUTRAL_COVER } from '../lib/cover';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { actions, state, musicLibrary } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import { trackCoverUrl } from '../lib/media';
import { trackCount } from '../lib/format';
import { CoverImage } from '../components/CoverImage';
import { pickPlaylistCoverTrack } from '../lib/playlists';
import { createPlaylistDialog, openPlaylistMenu, playlistMenuOptions } from '../components/playlistActions';
import { attachContextMenu } from '../lib/contextMenu';
import { t } from '../lib/i18n';
import metadata from '../design/CollectionMetadata.module.css';
import styles from './Playlists.module.css';
import { EmptyState } from '../components/EmptyState';
import { createResponsiveTap } from '../lib/responsiveTap';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { MusicReorderList } from '../components/MusicReorderList';
import { CheckIcon, MoveIcon, PlusIcon } from '../components/icons';

export default function Playlists() {
  const navigate = useNavigate();
  const byId = createMemo(() => collectionIndex(musicLibrary()));
  const names = createMemo(() => Object.keys(state.playlists));

  const search = createCollectionSearch();
  const filteredNames = search.filter(names, name => [name]);

  const cover = (name: string, ids: string[]) => {
    const track = pickPlaylistCoverTrack(name, ids, byId(), state.librarySettings);
    return track ? trackCoverUrl(track) : undefined;
  };

  const createNew = () => void createPlaylistDialog();
  const [editing, setEditing] = createSignal(false);
  const showSearch = createMemo(() => !editing() && names().length > 0);

  const menu = (e: MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    openPlaylistMenu(name, {}, e);
  };

  return (
    <div class="view">
      <ViewHeader
        title={t('playlists.title')}
        search={showSearch() ? search.reveal : undefined}
        barActions={[
          { label: t('playlists.new'), icon: () => <PlusIcon />, prominent: true, opensDialog: true, onSelect: createNew },
          ...(names().length > 1 ? [{
            label: t(editing() ? 'musicExplorer.done' : 'musicExplorer.edit'),
            icon: () => editing() ? <CheckIcon /> : <MoveIcon />,
            pressed: editing(),
            onSelect: () => setEditing(!editing()),
          }] : []),
        ]}
      />
      <div ref={(element) => registerPrimaryScroll(element)} class={styles.scroll} data-primary-scroll>
        <Show when={!editing()} fallback={
          <MusicReorderList items={names()} label={(name) => name} render={(name) => <span>{name}</span>} onChange={actions.reorderPlaylists} />
        }>
        <Show when={names().length > 0} fallback={<Show when={state.loading} fallback={<EmptyState>{t('playlists.empty')}</EmptyState>}><SkeletonCards /></Show>}>
          <Show when={filteredNames().length} fallback={<NoCollectionMatches />}>
          <div class={styles.grid}>
            <For each={filteredNames()}>
              {(name) => {
                const ids = () => state.playlists[name] ?? [];
                const href = `/playlists/${encodeURIComponent(name)}`;
                const tap = createResponsiveTap({
                  onTap: (event) => {
                    event.preventDefault();
                    navigate(href);
                  },
                });
                return (
                  <div class={styles.cardWrap} ref={(el) => attachContextMenu(el, () => playlistMenuOptions(name))}>
                    <A href={href} class={styles.card} data-pressable {...tap}>
                      <div class={styles.cover} style={{ position: 'relative', background: NEUTRAL_COVER }}><CoverImage src={cover(name, ids())} /></div>
                      <span class={styles.name}>{name}</span>
                      <span class={metadata.count}>{trackCount(ids().length)}</span>
                    </A>
                    <button
                      class={styles.cardMenu}
                      type="button"
                      aria-label={`${t('playlists.ariaOptions')}: ${name}`}
                      aria-haspopup="dialog"
                      onClick={(e) => menu(e, name)}
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="2" />
                        <circle cx="12" cy="12" r="2" />
                        <circle cx="19" cy="12" r="2" />
                      </svg>
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
          </Show>
        </Show>
        </Show>
      </div>
    </div>
  );
}
