import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { api, ApiError } from '../lib/api';
import { migrationApi, type MigrationCandidate, type MigrationJob, type MigrationTrack } from '../lib/migrationApi';
import { jobRunning } from '../lib/collectionState';
import { savedFromCatalogItem } from '../lib/saved';
import { confirmDialog } from '../lib/confirm';
import { formatBytes } from '../lib/format';
import { t } from '../lib/i18n';
import type { CatalogItem } from '../types/music';
import type { NativeEntitySubject } from './entityProfile';

const downloads = {
  album: { get: api.getAlbumDownload, start: api.startAlbumDownload },
  artist: { get: api.getArtistDownload, start: api.startArtistDownload },
};

/** Durable Core collection jobs, with navigation bookmarks and native playback untouched. */
export function createNativeCollection(props: {
  subject: () => NativeEntitySubject; generation: () => number; disconnected: () => boolean;
  songs: () => CatalogItem[]; owned: (item: CatalogItem) => boolean; refresh: () => Promise<void>;
}, confirm = confirmDialog) {
  const [job, setJob] = createSignal<MigrationJob | null>(null);
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal('');
  const [discography, setDiscography] = createSignal<CatalogItem[] | null>(null);
  let disposed = false, epoch = 0, revision = 0;
  let scope: { subject: NativeEntitySubject; signal: AbortSignal; current: () => boolean } | undefined;
  let reading = false;
  function verified(value: MigrationJob | null, expected: string, nullable: boolean): MigrationJob | null {
    if (value === null && nullable) return null;
    if (!value || typeof value.id !== 'string' || !value.id || value.provider !== expected || !value.selected_counts ||
      !Number.isInteger(value.selected_track_count) || value.selected_track_count < 0 || !Array.isArray(value.tracks) && value.tracks !== null) throw new Error('Missing collection job confirmation');
    return value;
  }
  async function adopt(next: MigrationJob | null, current: () => boolean) {
    if (!current()) return;
    const before = job(); setJob(next);
    if (next && (next.selected_counts.completed !== before?.selected_counts.completed || next.selected_counts.existing !== before?.selected_counts.existing)) await props.refresh();
  }
  async function read() {
    const owner = scope, id = owner?.subject.deezerId;
    if (!owner || !id || !owner.current() || reading || busy()) return;
    const submitted = revision; reading = true;
    try {
      const reply = await downloads[owner.subject.kind].get(id, owner.signal);
      if (!owner.current() || submitted !== revision) return;
      await adopt(verified(reply.job, `${owner.subject.kind}:${id}`, true), owner.current);
      if (owner.current() && submitted === revision) setError('');
      if (reply.job && owner.subject.kind === 'artist' && !discography() && owner.current()) await songs(owner);
    } catch { if (owner.current() && submitted === revision) setError(t('collectionControl.failed')); }
    finally { if (scope === owner) reading = false; }
  }
  createEffect(on(() => [props.subject().kind, props.subject().deezerId, props.generation(), props.disconnected()] as const,
    ([kind, id, generation, disconnected], previous) => {
      const owner = ++epoch, controller = new AbortController(); revision++; reading = false; setBusy(false); setError('');
      if (!previous || kind !== previous[0] || id !== previous[1] || generation !== previous[2]) { setJob(null); setDiscography(null); }
      scope = { subject: { ...props.subject() }, signal: controller.signal,
        current: () => !disposed && owner === epoch && generation === props.generation() && !controller.signal.aborted && !props.disconnected() };
      if (id && !/^\d{1,20}$/.test(id)) { setError(t('collectionControl.failed')); controller.abort(); }
      else if (!disconnected) void read();
      onCleanup(() => controller.abort());
    }));
  createEffect(() => {
    if (!jobRunning(job()) || props.disconnected()) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void read(); }, 3000);
    onCleanup(() => clearInterval(timer));
  });
  const resumed = () => { if (document.visibilityState === 'visible') void read(); };
  document.addEventListener('visibilitychange', resumed);
  onCleanup(() => { disposed = true; epoch++; document.removeEventListener('visibilitychange', resumed); });
  async function songs(owner: NonNullable<typeof scope>) {
    if (owner.subject.kind === 'album') return props.songs();
    if (discography()) return discography()!;
    if (!owner.subject.deezerId) throw new Error('Missing artist identity');
    const result = await api.getArtistDiscography(owner.subject.deezerId, owner.signal);
    if (!owner.current()) return [];
    if (!Array.isArray(result.tracklist)) throw new Error('Missing discography');
    setDiscography(result.tracklist); return result.tracklist;
  }
  async function mutate(work: (owner: NonNullable<typeof scope>) => Promise<void>) {
    const owner = scope; if (!owner?.current() || busy()) return;
    revision++; setBusy(true); setError('');
    try { await work(owner); }
    catch (failure) { if (owner.current()) setError(t(failure instanceof ApiError && failure.status === 403 ? 'android.permissionDenied' : 'collectionControl.failed')); }
    finally { if (owner.current()) setBusy(false); }
  }
  const download = () => mutate(async owner => {
    const id = owner.subject.deezerId; if (!id) throw new Error('Missing collection identity');
    const list = await songs(owner); if (!owner.current()) return;
    if (!list.length) throw new Error('Empty collection');
    if (owner.subject.kind === 'artist') {
      const missing = list.filter(item => !props.owned(item));
      const seconds = missing.reduce((total, item) => total + (item.duration ?? 0), 0);
      const accepted = await confirm({ title: t('collectionControl.downloadArtist', { title: owner.subject.name }),
        message: t('collectionControl.downloadArtistMessage', { n: missing.length, size: formatBytes(seconds * 192000 / 8) }), confirmLabel: t('collectionControl.download') }, owner.current);
      if (!accepted || !owner.current()) return;
    }
    const reply = await downloads[owner.subject.kind].start(id, owner.signal);
    if (!owner.current()) return;
    await adopt(verified(reply.job, `${owner.subject.kind}:${id}`, false), owner.current);
  });
  const saveSongs = () => mutate(async owner => {
    const list = await songs(owner); if (!owner.current()) return;
    if (!list.length) throw new Error('Empty collection');
    const accepted = await confirm({ title: t('collectionControl.addSongsTitle', { title: owner.subject.name }),
      message: t('collectionControl.addSongsMessage', { n: list.length }), confirmLabel: t('collectionControl.addSongs') }, owner.current);
    if (!accepted || !owner.current()) return;
    await api.setSavedEntries(list.map(savedFromCatalogItem), true, { signal: owner.signal });
    if (owner.current()) await props.refresh();
  });
  const control = (action: 'cancel' | 'retry') => mutate(async owner => {
    const selected = job(); if (!selected) return;
    const reply = await migrationApi.control(selected.id, action, { signal: owner.signal });
    if (!owner.current()) return;
    const next = verified(reply.job, selected.provider, false);
    if (next?.id !== selected.id) throw new Error('Different collection job');
    await adopt(next, owner.current);
  });
  const decide = (row: MigrationTrack, candidate?: MigrationCandidate) => mutate(async owner => {
    const selected = job(); if (!selected || !selected.tracks?.some(track => track.source_key === row.source_key && track.state === 'needs_review')) return;
    const reply = await migrationApi.decide(selected.id, candidate
      ? { source_key: row.source_key, decision: 'use_candidate', candidate }
      : { source_key: row.source_key, decision: 'skip' }, { signal: owner.signal });
    if (!owner.current()) return;
    let next = verified(reply.job, selected.provider, false);
    if (next?.id !== selected.id) throw new Error('Different collection job');
    if (!jobRunning(next)) {
      try {
        const resumed = await migrationApi.control(selected.id, 'resume', { signal: owner.signal });
        if (!owner.current()) return;
        const resumedJob = verified(resumed.job, selected.provider, false);
        if (resumedJob?.id !== selected.id) throw new Error('Different collection job');
        next = resumedJob;
      } catch { if (!owner.current()) return; /* Keep the confirmed decision if resume is temporarily unavailable. */ }
    }
    await adopt(next, owner.current);
  });
  return { job, busy, error, discography, download, saveSongs, control, decide, retry: read };
}
