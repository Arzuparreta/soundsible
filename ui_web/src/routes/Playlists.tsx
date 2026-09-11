import { NEUTRAL_COVER } from '../lib/cover';
import { createMemo, For, Show } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { state, musicLibrary } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import { trackCoverUrl } from '../lib/media';
import { trackCount } from '../lib/format';
import { CoverImage } from '../components/CoverImage';
import { pickPlaylistCoverTrack } from '../lib/playlists';
import { createPlaylistDialog, openPlaylistMenu, playlistMenuOptions } from '../components/playlistActions';
import { attachContextMenu } from '../lib/contextMenu';
import { t } from '../lib/i18n';
import styles from './Playlists.module.css';
import { EmptyState } from '../components/EmptyState';
import { createResponsiveTap } from '../lib/responsiveTap';
import { registerPrimaryScroll } from '../lib/scrollHistory';

export default function Playlists() {
  const navigate = useNavigate();
  const byId = createMemo(() => new Map(musicLibrary().map((t) => [t.id, t] as const)));
  const names = createMemo(() => Object.keys(state.playlists));

  const cover = (name: string, ids: string[]) => {
    const track = pickPlaylistCoverTrack(name, ids, byId(), state.librarySettings);
    return track ? trackCoverUrl(track) : undefined;
  };

  const createNew = () => void createPlaylistDialog();

  const menu = (e: MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    openPlaylistMenu(name, {}, e);
  };

  return (
    <div class="view">
      <ViewHeader title={t('playlists.title')} meta={`${names().length}`} />
      <div ref={(element) => registerPrimaryScroll(element)} class={styles.scroll} data-primary-scroll>
        <button class={styles.newBtn} type="button" onClick={createNew}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {t('playlists.new')}
        </button>
        <Show when={names().length > 0} fallback={<EmptyState>{t('playlists.empty')}</EmptyState>}>
          <div class={styles.grid}>
            <For each={names()}>
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
                      <span class={styles.count}>{trackCount(ids().length)}</span>
                    </A>
                    <button
                      class={styles.cardMenu}
                      type="button"
                      aria-label={t('playlists.ariaOptions')}
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
      </div>
    </div>
  );
}
