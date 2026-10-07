import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { request } from '../lib/http';
import { promptDialog } from '../lib/prompt';
import { confirmDialog } from '../lib/confirm';
import { openOverlay } from '../lib/overlay';
import { playlistNames } from '../lib/playlistOrder';
import { coverUrl } from '../lib/media';
import { t } from '../lib/i18n';
import type { MenuAction } from '../components/ActionMenu';
import { EmptyState } from '../components/EmptyState';
import type { LibrarySettings, PlaylistMap, Track } from '../types/music';
import styles from '../components/CoverPicker.module.css';

export interface PlaylistSnapshot { playlists?: PlaylistMap; settings?: LibrarySettings; tracks: Track[] }
interface Reply { playlists?: PlaylistMap; settings?: LibrarySettings }

export function nativePlaylistActions(name: string, state: () => PlaylistSnapshot, current: () => boolean,
  refresh: () => Promise<void>, failed: () => void): MenuAction[] {
  const original = state(); const ids = [...(original.playlists?.[name] ?? [])];
  const names = playlistNames(original.playlists ?? {}, original.settings?.playlist_order); const position = names.indexOf(name);
  const valid = () => current() && position >= 0;
  async function mutate(body: object, method: 'PATCH' | 'DELETE' = 'PATCH'): Promise<Reply | null> {
    if (!valid()) return null;
    const reply = await request<Reply>(`/api/library/playlist-edits/${encodeURIComponent(name)}`, { method, body: { ...body, expected_track_ids: ids }, timeoutMs: 15000 });
    if (!valid()) return null;
    await refresh(); return valid() ? reply : null;
  }
  const run = (action: () => Promise<void>) => { if (valid()) void action().catch(() => { if (valid()) { failed(); void refresh(); } }); };
  async function move(delta: number) {
    if (!valid() || position + delta < 0 || position + delta >= names.length) return;
    const order = [...names]; [order[position], order[position + delta]] = [order[position + delta], order[position]];
    const reply = await request<Reply>('/api/library/playlist-edits', { method: 'PATCH', body: { order, expected_order: names }, timeoutMs: 15000 });
    if (!valid()) return;
    if (JSON.stringify(reply.settings?.playlist_order) !== JSON.stringify(order)) throw new Error('Missing order confirmation');
    await refresh();
  }
  async function rename() {
    const next = await promptDialog({ title: t('playlistActions.renameTitle'), initial: name, confirmLabel: t('playlistActions.renameConfirm') }, valid);
    if (!next || next === name || !valid()) return;
    const reply = await mutate({ name: next });
    if (reply && (!reply.playlists || !Object.hasOwn(reply.playlists, next) || Object.hasOwn(reply.playlists, name))) throw new Error('Missing rename confirmation');
  }
  async function remove() {
    if (!await confirmDialog({ title: t('playlistActions.deleteTitle'), message: t('playlistActions.deleteMsg', { name }), confirmLabel: t('playlistActions.deleteConfirm'), danger: true }, valid) || !valid()) return;
    const reply = await mutate({}, 'DELETE');
    if (reply && (!reply.playlists || Object.hasOwn(reply.playlists, name))) throw new Error('Missing delete confirmation');
  }
  async function duplicate() {
    const copy = await promptDialog({ title: t('playlistActions.duplicate'), initial: name + t('toast.playlistDuplicateSuffix'), confirmLabel: t('playlistPicker.newConfirm') }, valid);
    if (!copy || !valid()) return;
    const created = await request<Reply>('/api/library/playlists', { method: 'POST', body: { name: copy }, timeoutMs: 15000 });
    if (!valid()) return;
    if (!created.playlists || !Object.hasOwn(created.playlists, copy)) throw new Error('Missing creation confirmation');
    const filled = await request<Reply>(`/api/library/playlist-edits/${encodeURIComponent(copy)}`, { method: 'PATCH', body: { expected_track_ids: [], track_ids: ids }, timeoutMs: 15000 });
    if (!valid()) return;
    if (JSON.stringify(filled.playlists?.[copy]) !== JSON.stringify(ids)) throw new Error('Missing duplication confirmation');
    await refresh();
  }
  function cover() {
    if (!valid()) return;
    const byId = new Map(original.tracks.map(track => [track.id, track]));
    const tracks = [...new Set(ids)].flatMap(id => { const track = byId.get(id); return track && track.source !== 'preview' ? [track] : []; });
    openOverlay(close => {
      const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal(false);
      let disposed = false; const controller = new AbortController(); onCleanup(() => { disposed = true; controller.abort(); });
      createEffect(() => { if (!valid()) { controller.abort(); close(); } });
      async function pick(id: string | null) {
        if (!valid() || disposed || busy()) return; setBusy(true); setError(false);
        try {
          const reply = await request<Reply>(`/api/library/playlist-edits/${encodeURIComponent(name)}`, { method: 'PATCH', body: { expected_track_ids: ids, cover_track_id: id }, signal: controller.signal });
          if (!valid() || disposed) return;
          if ((reply.settings?.playlist_covers?.[name] ?? null) !== id) throw new Error('Missing cover confirmation');
          await refresh(); if (valid() && !disposed) close();
        } catch { if (valid() && !disposed) setError(true); }
        finally { if (valid() && !disposed) setBusy(false); }
      }
      return <div class={styles.picker} data-testid="android-playlist-cover"><header class={styles.head}><span class={styles.title}>{t('coverPicker.header', { name })}</span></header>
        <button class={styles.none} disabled={busy()} onClick={() => void pick(null)}>{t('coverPicker.none')}</button>
        <Show when={error()}><p role="alert">{t('toast.playlistCoverFailed')}</p></Show>
        <For each={tracks} fallback={<EmptyState compact>{t('coverPicker.empty')}</EmptyState>}>{track => <button class={styles.cell} aria-label={track.title} disabled={busy()} onClick={() => void pick(track.id)}><img class={styles.cover} src={coverUrl(track.id, 'thumb')} alt="" /></button>}</For>
      </div>;
    }, { ariaLabel: () => t('coverPicker.header', { name }) });
  }
  return [
    { label: t('playlistActions.rename'), disabled: !valid(), onSelect: () => run(rename) },
    { label: t('playlistActions.duplicate'), disabled: !valid(), onSelect: () => run(duplicate) },
    { label: t('playlistActions.changeCover'), disabled: !valid(), onSelect: cover },
    { label: t('musicList.moveUp'), disabled: !valid() || position <= 0, onSelect: () => run(() => move(-1)) },
    { label: t('musicList.moveDown'), disabled: !valid() || position === names.length - 1, onSelect: () => run(() => move(1)) },
    { label: t('playlistActions.deleteList'), danger: true, disabled: !valid(), onSelect: () => run(remove) },
  ];
}

export function nativePlaylistOccurrenceActions(name: string, index: number, state: () => PlaylistSnapshot,
  current: () => boolean, refresh: () => Promise<void>, failed: () => void): MenuAction[] {
  const ids = [...(state().playlists?.[name] ?? [])];
  const valid = () => current() && index >= 0 && index < ids.length;
  async function edit(delta: number | null) {
    if (!valid()) return;
    const rows = [...ids];
    if (delta === null) rows.splice(index, 1);
    else { if (index + delta < 0 || index + delta >= rows.length) return; [rows[index], rows[index + delta]] = [rows[index + delta], rows[index]]; }
    try {
      const reply = await request<Reply>(`/api/library/playlist-edits/${encodeURIComponent(name)}`, { method: 'PATCH', body: { expected_track_ids: ids, track_ids: rows }, timeoutMs: 15000 });
      if (!valid()) return;
      if (JSON.stringify(reply.playlists?.[name]) !== JSON.stringify(rows)) throw new Error('Missing occurrence confirmation');
      await refresh();
    } catch { if (valid()) { failed(); void refresh(); } }
  }
  return [
    { label: t('musicList.moveUp'), disabled: !valid() || index === 0, onSelect: () => void edit(-1) },
    { label: t('musicList.moveDown'), disabled: !valid() || index === ids.length - 1, onSelect: () => void edit(1) },
    { label: t('trackActions.removeFromPlaylist'), disabled: !valid(), onSelect: () => void edit(null) },
  ];
}

export async function createNativePlaylist(current: () => boolean, refresh: () => Promise<void>, failed: () => void): Promise<void> {
  const name = await promptDialog({ title: t('playlistPicker.new'), placeholder: t('playlistPicker.newPlaceholder'), confirmLabel: t('playlistPicker.newConfirm') }, current);
  if (!name || !current()) return;
  try {
    const reply = await request<Reply>('/api/library/playlists', { method: 'POST', body: { name }, timeoutMs: 15000 });
    if (!current()) return;
    if (!reply.playlists || !Object.hasOwn(reply.playlists, name)) throw new Error('Missing creation confirmation');
    await refresh();
  } catch { if (current()) failed(); }
}
