import { createMemo, For, Show, type JSX } from 'solid-js';
import { A } from '@solidjs/router';
import { state, actions } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import { coverUrl } from '../lib/media';
import { trackCount } from '../lib/format';
import { pickPlaylistCoverId } from '../lib/playlists';
import { openPlaylistMenu, playlistMenuOptions } from '../components/playlistActions';
import { attachContextMenu } from '../lib/contextMenu';
import { promptDialog } from '../lib/prompt';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import styles from './Playlists.module.css';

export default function Playlists() {
  const byId = createMemo(() => new Map(state.library.map((t) => [t.id, t] as const)));
  const names = createMemo(() => Object.keys(state.playlists));

  const coverBg = (name: string, ids: string[]): JSX.CSSProperties => {
    const grad = 'linear-gradient(135deg, var(--bg-elevated), var(--bg-inset))';
    const id = pickPlaylistCoverId(name, ids, byId() as Map<string, Track>, state.librarySettings);
    return id ? { background: `url("${coverUrl(id)}") center / cover no-repeat, ${grad}` } : { background: grad };
  };

  const createNew = async () => {
    const name = await promptDialog({ title: t('playlists.new'), placeholder: t('playlists.newPlaceholder'), confirmLabel: t('playlists.newConfirm') });
    if (name) void actions.createPlaylist(name);
  };

  const menu = (e: MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    openPlaylistMenu(name, {}, e);
  };

  return (
    <div class="view">
      <ViewHeader title={t('playlists.title')} meta={`${names().length}`} />
      <div class={styles.scroll}>
        <button class={styles.newBtn} type="button" onClick={createNew}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {t('playlists.new')}
        </button>
        <Show when={names().length > 0} fallback={<p class={styles.empty}>{t('playlists.empty')}</p>}>
          <div class={styles.grid}>
            <For each={names()}>
              {(name) => {
                const ids = () => state.playlists[name] ?? [];
                return (
                  <div class={styles.cardWrap} ref={(el) => attachContextMenu(el, () => playlistMenuOptions(name))}>
                    <A href={`/playlists/${encodeURIComponent(name)}`} class={styles.card}>
                      <div class={styles.cover} style={coverBg(name, ids())} />
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
