import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import { promptDialog } from '../lib/prompt';
import { request } from '../lib/http';
import { playlistNames } from '../lib/playlistOrder';
import { savedFromTrack } from '../lib/saved';
import { t } from '../lib/i18n';
import { EmptyState } from '../components/EmptyState';
import styles from '../components/PlaylistPicker.module.css';
import type { PlaylistMap, Track } from '../types/music';

export function openNativePlaylistPicker(track: Track, playlists: () => PlaylistMap, current: () => boolean, refresh: () => Promise<void>, order?: () => unknown): void {
  openOverlay(close => {
    const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal(false);
    const controller = new AbortController(); let disposed = false;
    onCleanup(() => { disposed = true; controller.abort(); });
    createEffect(() => { if (!current()) { controller.abort(); close(); } });
    const valid = () => current() && !disposed && !controller.signal.aborted;
    async function add(name: string, create = false) {
      if (!valid() || busy()) return;
      setBusy(true); setError(false);
      try {
        if (create) await request('/api/library/playlists', { method: 'POST', body: { name }, signal: controller.signal });
        if (!valid()) return;
        // Preview membership is a claim on the identity; acquire no audio bytes.
        if (track.source === 'preview') await request('/api/library/saved/set', { method: 'POST', body: { entries: [savedFromTrack(track)], saved: true }, signal: controller.signal });
        if (!valid()) return;
        const answer = await request<{ playlists?: PlaylistMap }>(`/api/library/playlists/${encodeURIComponent(name)}/tracks`, { method: 'POST', body: { track_id: track.id }, signal: controller.signal });
        if (!valid()) return;
        if (!answer.playlists?.[name]?.includes(track.id)) throw new Error('Missing playlist confirmation');
        await refresh(); if (valid()) close();
      } catch { if (valid()) setError(true); }
      finally { if (valid()) setBusy(false); }
    }
    async function create() {
      const name = await promptDialog({ title: t('playlistPicker.new'), placeholder: t('playlistPicker.newPlaceholder'), confirmLabel: t('playlistPicker.newConfirm') }, valid);
      if (name && valid()) await add(name, true);
    }
    return <div class={styles.picker} data-testid="android-playlist-picker" aria-busy={busy()}>
      <header class={styles.head}><span class={styles.title}>{t('playlistPicker.title')}</span></header>
      <button class={styles.new} disabled={busy()} onClick={() => void create()}>{t('playlistPicker.new')}</button>
      <Show when={error()}><p role="alert">{t('toast.addToPlaylistFailed')}</p></Show>
      <For each={playlistNames(playlists(), order?.())} fallback={<EmptyState compact>{t('playlistPicker.empty')}</EmptyState>}>{name => <button class={styles.item} disabled={busy()} onClick={() => void add(name)}><span class={styles.itemName}>{name}</span><span class={styles.itemCount}>{playlists()[name]?.length ?? 0}</span></button>}</For>
    </div>;
  }, { ariaLabel: () => t('playlistPicker.title') });
}
