import NativeSettings from './Settings';
import type { createNativeAppearance } from './appearance';
import { createSearchHistoryStorage } from '../lib/searchHistoryStorage';
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { t } from '../lib/i18n';
import { musicLibraryRows } from '../lib/musicLibrary';
import { buildIdentityIndex, trackKeys } from '../lib/playbackIdentity';
import { songMarkAction } from './songMarks';
import { nativeEntityMark } from './entityMarks';
import { createAccountRefresh } from './accountRefresh';
import type { SavedEntity } from '../lib/savedEntityIdentity';
import { openNativePlaylistPicker } from './PlaylistPicker';
import { openNativeLyrics } from './Lyrics';
import { openNativeMetadataEditor } from './metadataEditor';
import { nativePlaylistActions, nativePlaylistOccurrenceActions, createNativePlaylist } from './playlistActions';
import { savedToTrack } from '../lib/saved';
import type { SavedEntry, Track } from '../types/music';
import { registerArtworkMetadata } from '../lib/media';
import { ApiError, request, setUnauthorizedHandler } from '../lib/http';
import type { User } from '../lib/session';
import { engine, useEngine, watchEngine } from './engine';
import NativeDownloads from './Downloads';
import NativeMigrate from './Migrate';
import { attachNativeBack } from './back';
import { registerNativeBack } from './backNavigation';
import { createMusicAcquisition } from './acquisition';
import { createNativeFileDeletion } from './fileDeletion';
import { nativeFileDeletionAction } from './fileDeletionMenu';
import { retireNativeSource } from './sourceRetirement';
import { nativePlayingTrack } from './programIdentity';
import type { DownloadQueueItem } from '../types/download';
import LibraryBrowser, { type BrowseSnapshot } from './LibraryBrowser';
import PodcastBrowser from './PodcastBrowser';
import { isPodcastTrack } from '../lib/track';
import CatalogSearch from './CatalogSearch';
import { nativeProgramTransport, mixedProgram } from './playback';
import { createProgramRuntime, type ProgramState } from '../lib/program/runtime';
import ProgramTransport from '../components/ProgramTransport';
import { openContextMenu, ContextMenuOutlet, dismissContextMenu } from '../lib/contextMenu';
import { OverlayOutlet, discardOverlays } from '../lib/overlay';
import { ToastOutlet } from '../lib/toast';
import { programLibraryMenu } from '../lib/program/libraryMenu';
import ProgramQueue from '../components/ProgramQueue';
import { offline, availableLibrary, availableProgram, type OfflineState, type OfflineCommand } from './offline';
import { offlineActions, openOfflineManager } from './OfflineManager';
import logo from '../../../branding/logo-mark.svg';
import styles from './AndroidStart.module.css';

export default function AndroidStart(props: { appearance: ReturnType<typeof createNativeAppearance> }) {
  const [program, setProgram] = createSignal<ProgramState | null>(null);
  const [programPending, setProgramPending] = createSignal(false);
  let generation = -1;
  let authFailureHandled = false;
  const runtime = createProgramRuntime(nativeProgramTransport, {
    state: state => {
      setProgram(state);
      if (state?.errorStatus === 401 && !authFailureHandled) { authFailureHandled = true; void expireSession(); }
    },
    pending: setProgramPending,
    error: () => setError(t('common.loadFailed')),
  });
  async function play(tracks: Track[], selectedIndex: number) {
    authFailureHandled = false;
    const available = stale() && offlineState() ? availableProgram(tracks, selectedIndex, offlineState()!) : { tracks, index: selectedIndex };
    const queue = mixedProgram(available.tracks, available.index);
    if (queue.index < 0) return;
    await runtime.execute({ action: 'queue', index: queue.index, tracks: queue.tracks }).catch(() => {});
  }
  const [origin, setOrigin] = createSignal('');
  const [server, setServer] = createSignal('');
  const [user, setUser] = createSignal<User | null>(null);
  const [needsLogin, setNeedsLogin] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [stale, setStale] = createSignal(false);
  const [eventsOnline, setEventsOnline] = createSignal(false);
  const [snapshot, setSnapshot] = createSignal<BrowseSnapshot | null>(null);
  const [savedEntries, setSavedEntries] = createSignal<SavedEntry[]>([]);
  const [downloadItems, setDownloadItems] = createSignal<DownloadQueueItem[]>([]);
  const [savedEntities, setSavedEntities] = createSignal<SavedEntity[]>([]);
  function entityMenu(entry: SavedEntity, event?: MouseEvent) {
    const captured = epoch; const current = () => captured === epoch && !!user() && !stale();
    openContextMenu({ title: entry.name, subtitle: entry.artist, actions: [nativeEntityMark(entry, savedEntities, current, sync, () => { if (current()) setError(t('savedEntities.failed')); })] }, event);
  }
  function playlistMenu(name: string, event?: MouseEvent) {
    const captured = epoch; const current = () => captured === epoch && !!user() && !stale();
    openContextMenu({ title: name, actions: nativePlaylistActions(name, () => snapshot() ?? { tracks: [] }, current, sync, () => { if (current()) setError(t('common.loadFailed')); }) }, event);
  }
  function newPlaylist() {
    const captured = epoch; const current = () => captured === epoch && !!user() && !stale();
    void createNativePlaylist(current, sync, () => { if (current()) setError(t('common.loadFailed')); });
  }
  const isFavourite = (track: Track) => { const keys = trackKeys(track); return savedEntries().some(entry => entry.favourite && entry.keys.some(key => keys.includes(key))); };
  const [surface, setSurface] = createSignal<'library' | 'search' | 'podcasts' | 'downloads' | 'migrate' | 'settings'>('library');
  const [libraryTab, setLibraryTab] = createSignal<'songs' | 'playlists'>('songs');
  const [revision, setRevision] = createSignal(0);
  const [offlineState, setOfflineState] = createSignal<OfflineState | null>(null);
  const searchHistory = createSearchHistoryStorage(key => JSON.stringify(['android', origin(), user()?.id ?? null, key]));
  async function offlineCommand(command: OfflineCommand) {
    const current = epoch;
    try {
      const result = await offline.command({ ...command, ...(command.action === 'prepare' ? { playlists: snapshot()?.playlists ?? command.playlists } : {}), generation });
      if (current === epoch) {
        const lostProfile = !result.user && !!offlineState()?.user && !!user();
        if (JSON.stringify(result) !== JSON.stringify(offlineState())) setOfflineState(result);
        if (lostProfile) await expireSession();
      }
    } catch {
      if (current === epoch) {
        await restoreOffline(false).catch(() => {});
        if (current === epoch) setError(t(command.action === 'remove' ? 'android.offlineRemovalFailed' : 'android.offlineFailed'));
      }
    }
  }
  async function restoreOffline(restoreLibrary = true) {
    const current = epoch;
    const result = await offline.command({ action: 'state', generation });
    if (current !== epoch) return;
    setOfflineState(result);
    if (restoreLibrary && result.user && result.items.length) { setUser(result.user); setSnapshot(availableLibrary(result)); setStale(true); }
  }
  let username: HTMLInputElement | undefined;
  let password: HTMLInputElement | undefined;
  let epoch = 0;
  let syncEpoch = 0;
  let cancelEvents: (() => void) | undefined;
  let controller = new AbortController();
  function reset(stopPlayback = true) {
    epoch++; syncEpoch++; discardOverlays(); dismissContextMenu(); controller.abort(); controller = new AbortController();
    cancelEvents?.(); cancelEvents = undefined;
    if (stopPlayback) {
      const active = program();
      if (active?.queue.length) void nativeProgramTransport.command({ generation, action: 'stop', queueToken: active.queueToken, programToken: active.programToken }).catch(() => {});
      runtime.unbind();
    }
    setOfflineState(null); setProgram(null); setUser(null); registerArtworkMetadata([]); setSnapshot(null); setSavedEntries([]); setSavedEntities([]); setDownloadItems([]); setSurface('library'); setRevision(0); setEventsOnline(false); setStale(false);
  }
  let expiration: Promise<void> | null = null;
  function expireSession(): Promise<void> {
    if (expiration) return expiration;
    reset(); setBusy(true); setNeedsLogin(false);
    expiration = (async () => {
      try {
        const next = await engine.clear({ forget: false });
        generation = next.generation; void runtime.bind(generation); useEngine(next); setNeedsLogin(true);
      } catch { setError(t('android.connectFailed')); }
      finally { setBusy(false); expiration = null; }
    })();
    return expiration;
  }
  const sync = createAccountRefresh(syncOnce, () => epoch, () => !!user());
  const acquisition = createMusicAcquisition(() => epoch, () => !!user() && !stale(), () => controller.signal, () => snapshot()?.tracks ?? [], downloadItems, sync);
  const fileDeletion = createNativeFileDeletion(() => epoch, () => !!user() && !stale(), () => controller.signal,
    () => [...(snapshot()?.tracks ?? []), ...(offlineState()?.user?.id === user()?.id ? offlineState()?.items.map(item => item.track) ?? [] : [])], async id => {
      const owner = epoch;
      await retireNativeSource(nativeProgramTransport, id, generation, () => epoch === owner && !!user());
    }, async id => {
      const owner = epoch, account = generation;
      try {
        const state = await offline.command({ action: 'remove', ids: [id], generation: account });
        if (owner !== epoch) return;
        setOfflineState(state);
        if (state.items.some(item => item.track.id === id)) throw new Error('Offline copy retirement not confirmed');
      } catch (failure) {
        if (owner === epoch) await restoreOffline(false).catch(() => {});
        throw failure;
      }
    }, sync);
  const isActive = (track: Track) => nativePlayingTrack(program(), snapshot()?.tracks ?? [], track);
  async function syncOnce() {
    if (!user()) return;
    const current = epoch;
    const job = ++syncEpoch;
    try {
      const state = await request<{ requires_login: boolean; user: User | null }>('/api/auth/state', { signal: controller.signal });
      if (current !== epoch || job !== syncEpoch) return;
      if (!state.user || (user() && user()!.id !== state.user.id)) { await expireSession(); return; }
      const [data, saved, entities, downloads] = await Promise.all([
        request<BrowseSnapshot>('/api/library', { timeoutMs: 30000, signal: controller.signal, cache: 'no-store' }),
        request<{ saved: SavedEntry[] }>('/api/library/saved', { signal: controller.signal, cache: 'no-store' }),
        request<{ entities: SavedEntity[] }>('/api/library/saved-entities', { signal: controller.signal, cache: 'no-store' }),
        request<{ queue: DownloadQueueItem[] }>('/api/downloader/queue/status', { signal: controller.signal, cache: 'no-store' }),
      ]);
      if (current !== epoch || job !== syncEpoch) return;
      if (!Array.isArray(downloads.queue)) throw new Error('Invalid download snapshot');
      if (!Array.isArray(data.tracks)) throw new Error('Invalid library');
      if (!Array.isArray(entities.entities)) throw new Error('Invalid entity bookmark snapshot');
      if (!Array.isArray(saved.saved)) throw new Error('Invalid saved-song snapshot');
      const index = buildIdentityIndex(data.tracks);
      const resolved = saved.saved.map(entry => savedToTrack(entry, index)).filter((track): track is Track => !!track);
      setSnapshot({ ...data, podcast_tracks: data.tracks.filter(isPodcastTrack), tracks: musicLibraryRows(data.tracks, resolved) }); setSavedEntries(saved.saved); setSavedEntities(entities.entities); setDownloadItems(downloads.queue); setRevision(n => n + 1); setStale(false); setError('');
    } catch (failure) {
      if (current !== epoch || job !== syncEpoch) return;
      if (failure instanceof ApiError && failure.status === 401) await expireSession();
      else if (failure instanceof ApiError && failure.status === 403) { setError(t('android.permissionDenied')); setStale(false); }
      else setStale(true);
    }
  }
  async function resolveIdentity() {
    const current = epoch;
    let state = await request<{ requires_login: boolean; user: User | null }>('/api/auth/state', { signal: controller.signal });
    if (current !== epoch) return;
    // The passwordless instance still gets a real account session for sockets.
    if (!state.requires_login) {
      const signed = await request<{ user: User }>('/api/auth/login', { method: 'POST', body: { device_name: 'Soundsible Android' }, signal: controller.signal });
      state = { ...state, user: signed.user };
    }
    if (current !== epoch) return;
    setNeedsLogin(!state.user);
    if (!state.user) { await expireSession(); return; }
    if (user() && user()!.id !== state.user.id) { await expireSession(); return; }
    setUser(state.user);
    await sync();
    if (current !== epoch || !user()) return;
    await attachEvents(current);
  }
  async function attachEvents(current: number) {
    cancelEvents?.(); cancelEvents = undefined;
    const stop = await watchEngine(event => {
      if (current !== epoch || !user()) return;
      if (event === 'connect') { setEventsOnline(true); void sync(); }
      else if (event === 'disconnect' || event === 'connect_error') setEventsOnline(false);
      else void sync();
    });
    if (current !== epoch) stop(); else cancelEvents = stop;
  }
  async function revalidateIdentity() {
    const current = epoch;
    setBusy(true); setError('');
    try {
      await resolveIdentity();
    } catch (failure) {
      if (current !== epoch) return;
      if (failure instanceof ApiError && failure.status === 401) await expireSession();
      else if (failure instanceof ApiError && failure.status === 403) { setError(t('android.permissionDenied')); setStale(false); }
      else setStale(true);
    } finally { if (current === epoch) setBusy(false); }
  }
  async function refresh() {
    if (busy()) return;
    const current = epoch;
    if (user()) await sync(); else await revalidateIdentity();
    if (current === epoch && user() && !eventsOnline()) {
      try { await attachEvents(current); } catch { if (current === epoch) setEventsOnline(false); }
    }
  }

  async function connect(event?: SubmitEvent) {
    event?.preventDefault();
    if (busy()) return;
    setBusy(true); setError(''); reset();
    try {
      const next = await engine.configure({ origin: origin().trim() });
      generation = next.generation; void runtime.bind(generation); useEngine(next); setServer(next.origin); setOrigin(next.origin);
      await resolveIdentity();
    } catch { setError(t('android.connectFailed')); }
    finally { setBusy(false); }
  }
  async function signIn(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    setBusy(true); setError('');
    try {
      await request('/api/auth/login', { method: 'POST', body: { username: username?.value, password: password?.value, device_name: 'Soundsible Android' }, signal: controller.signal });
      if (password) password.value = '';
      await resolveIdentity();
    } catch (failure) { setError(t(failure instanceof ApiError && failure.status === 401 ? 'android.wrongLogin' : 'android.connectFailed')); }
    finally { if (password) password.value = ''; setBusy(false); }
  }
  async function leave(forget: boolean) {
    if (busy()) return;
    setBusy(true); reset(); setError('');
    try { await request('/api/auth/logout', { method: 'POST', timeoutMs: 3000 }); }
    catch { /* Local credential removal also works when the engine is offline. */ }
    finally {
      const next = await engine.clear({ forget }); generation = next.generation; void runtime.bind(generation); useEngine(next);
      if (forget) { setServer(''); setNeedsLogin(false); }
      else setNeedsLogin(true);
      setBusy(false);
    }
  }
  registerNativeBack(() => {
    if (surface() === 'library') return false;
    setLibraryTab('songs'); setSurface('library'); return true;
  });
  onMount(() => {
    const removeBack = attachNativeBack(() => setError(t('common.loadFailed')));
    onCleanup(removeBack);
    setUnauthorizedHandler(() => { void expireSession(); });
    void engine.state().then(state => {
      generation = state.generation; useEngine(state); void runtime.bind(generation); setOrigin(state.origin); setServer(state.origin);
      if (state.origin) void restoreOffline().catch(() => {}).then(() => revalidateIdentity());
    }).finally(() => window.__SOUNDSIBLE_BOOT__?.complete());
    let lastDownloadPoll = 0;
    let lastOfflinePoll = 0;
    const offlineInterval = setInterval(() => {
      if (user() && document.visibilityState === 'visible' && downloadItems().some(item => item.status === 'pending' || item.status === 'downloading') && Date.now() - lastDownloadPoll >= 1000) { lastDownloadPoll = Date.now(); void sync(); }
      const preparing = offlineState()?.items.some(item => item.state === 'queued' || item.state === 'downloading');
      if (generation >= 0 && document.visibilityState === 'visible' && Date.now() - lastOfflinePoll >= (preparing ? 1000 : 10000)) { lastOfflinePoll = Date.now(); void offlineCommand({ action: 'state' }); }
    }, 1000);
    const interval = setInterval(() => { if (user() && document.visibilityState === 'visible') void sync(); }, 30000);
    const resume = () => { if (user() && document.visibilityState === 'visible') void sync(); };
    document.addEventListener('visibilitychange', resume);
    onCleanup(() => { clearInterval(interval); clearInterval(offlineInterval); document.removeEventListener('visibilitychange', resume); reset(false); runtime.unbind(); setUnauthorizedHandler(null); });
  });
  return <main class={user() || program()?.queue.length ? styles.connected : styles.start} data-testid={server() ? 'android-configured' : 'android-unconfigured'}>
    <Show when={user()} fallback={<><img src={logo} alt="" width="64" height="64" /><h1>{t('android.title')}</h1></>}>
      {account => <header><h1>{t('library.title')}</h1><p>{account().display_name} · {server()}</p>
        <button type="button" disabled={busy()} onClick={() => void refresh()}>{t('android.refresh')}</button>
        <button type="button" disabled={busy()} onClick={() => void leave(false)}>{t('android.logout')}</button>
        <button type="button" disabled={busy()} onClick={() => void leave(true)}>{t('android.changeServer')}</button></header>}
    </Show>
    <Show when={!user()}>
      <form class={styles.form} onSubmit={connect}>
        <label class={styles.field}>{t('android.server')}<input type="url" required value={origin()} placeholder="http://10.0.2.2:5005" autocomplete="url" disabled={busy()} onInput={event => setOrigin(event.currentTarget.value)} /></label>
        <p>{t('android.serverHint')}</p><button type="submit" disabled={busy()}>{t('android.connect')}</button>
      </form>
      <Show when={needsLogin()}><form class={styles.form} onSubmit={signIn}>
        <label class={styles.field}>{t('android.username')}<input ref={username} autocomplete="username" required disabled={busy()} /></label>
        <label class={styles.field}>{t('android.password')}<input ref={password} type="password" autocomplete="current-password" disabled={busy()} /></label>
        <button type="submit" disabled={busy()}>{t('android.login')}</button>
      </form></Show>
    </Show>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <Show when={busy()}><p role="status">{t('common.loading')}</p></Show>
    <Show when={stale() && !user()}><p role="status">{t('library.unreachable')} <button disabled={busy()} onClick={() => void refresh()}>{t('common.retry')}</button></p></Show>
    <Show when={!user() && server() && !needsLogin()}><button disabled={busy()} onClick={() => void refresh()}>{t('android.refresh')}</button><button disabled={busy()} onClick={() => void leave(false)}>{t('android.logout')}</button><button disabled={busy()} onClick={() => void leave(true)}>{t('android.changeServer')}</button></Show>
    <Show when={program()?.queue.length ? program() : null}>{state => <><ProgramTransport state={state()} pending={programPending()} command={runtime.execute} onLyrics={user() && !stale() ? () => {
      const captured = epoch;
      openNativeLyrics(program, () => snapshot()?.tracks ?? [], savedEntries, () => captured === epoch && !!user() && !stale(), runtime.execute);
    } : undefined} /><ProgramQueue state={state()} pending={programPending()} command={runtime.execute} /></>}</Show>
    <Show when={user()}>
      <Show when={stale()}><p role="status">{t('library.unreachable')} <button onClick={() => void refresh()}>{t('common.retry')}</button></p></Show>
      <Show when={!eventsOnline() && !stale()}><p class={styles.notice}>{t('android.eventsPending')}</p></Show>
      <Show when={snapshot()} fallback={<button onClick={() => void refresh()}>{t('common.retry')}</button>}>
        {data => <><nav class={styles.tabs} aria-label={t('nav.library')}><button aria-pressed={surface() === 'library'} onClick={() => { setLibraryTab('songs'); setSurface('library'); }}>{t('nav.library')}</button><button aria-pressed={surface() === 'search'} data-android-discover onClick={() => setSurface('search')}>{t('nav.search')}</button><button data-android-podcasts aria-pressed={surface() === 'podcasts'} onClick={() => setSurface('podcasts')}>{t('nav.podcasts')}</button><button data-android-downloads aria-pressed={surface() === 'downloads'} onClick={() => setSurface('downloads')}>{t('downloads.title')}</button><button data-android-migrate aria-pressed={surface() === 'migrate'} onClick={() => setSurface('migrate')}>{t('migrate.title')}</button><button data-android-settings aria-pressed={surface() === 'settings'} onClick={() => setSurface('settings')}>{t('nav.settings')}</button></nav>
          <Show when={surface() === 'library'} fallback={<Show when={surface() === 'settings'} fallback={<Show when={surface() === 'podcasts'} fallback={<Show when={surface() === 'downloads'} fallback={<Show when={surface() === 'migrate'} fallback={<CatalogSearch history={searchHistory} generation={generation} tracks={data().tracks} saved={savedEntries()} disconnected={stale()} activeId={program()?.id} isActive={isActive} onAcquire={acquisition.add} onPlay={track => play([track], 0)} onChanged={sync} />}><NativeMigrate generation={generation} available={() => !stale()} current={() => !!user()} origin={origin()} onOpenPlaylists={() => { setLibraryTab('playlists'); setSurface('library'); void sync(); }} /></Show>}><NativeDownloads items={downloadItems()} disconnected={stale()} generation={generation} onChanged={sync} /></Show>}><PodcastBrowser generation={generation} subscriptions={data().podcast_subscriptions ?? []} acquired={data().podcast_tracks ?? []} disconnected={stale()} activeId={program()?.id} onPlay={track => play([track], 0)} onChanged={sync} /></Show>}><NativeSettings appearance={props.appearance} busy={busy()} user={user()!} identity={() => epoch} available={() => !stale()} signal={controller.signal} history={searchHistory} onLogout={() => leave(false)} onUser={async updated => {
              const owner = epoch;
              if (updated.id !== user()?.id) throw new Error('Account changed');
              setUser(updated); await restoreOffline(false);
              if (owner !== epoch) return;
              await sync();
              if (owner === epoch && user()) await attachEvents(owner);
            }} /></Show>}>
          <LibraryBrowser initialTab={libraryTab()} onEntityMenu={entityMenu} onPlaylistMenu={playlistMenu} onCreatePlaylist={newPlaylist} isFavourite={isFavourite} snapshot={data()} isActive={isActive} revision={revision()} disconnected={stale()} offline={offlineState()} activeId={program()?.id} onPlay={play}
          onManageOffline={() => { const captured = generation; openOfflineManager(offlineState, command => captured === generation ? offlineCommand(command) : Promise.resolve()); }}
          onCollectionMenu={(tracks, title, event, context) => {
            const captured = epoch; const current = () => captured === epoch && !!user() && !stale();
            openContextMenu({ title, actions: [...(context?.bookmark ? [nativeEntityMark(context.bookmark, savedEntities, current, sync, () => { if (current()) setError(t('savedEntities.failed')); })] : []), ...(context?.kind === 'playlists' ? nativePlaylistActions(context.id, () => snapshot() ?? { tracks: [] }, current, sync, () => { if (current()) setError(t('common.loadFailed')); }) : []), ...offlineActions(tracks, offlineState, offlineCommand, () => generation)] }, event);
          }}
          onMenu={(track, event, context) => {
            const captured = epoch; const current = () => captured === epoch && !!user() && !stale();
            const menu = programLibraryMenu(track, program, programPending, runtime.execute);
            openContextMenu({ ...menu, actions: [...(menu.actions ?? []),
              ...(track.source === 'preview' ? [{ label: t('collectionControl.download'), disabled: !current() || acquisition.busy(track.id), onSelect: () => { if (current()) void acquisition.add(track).catch(() => { if (current()) setError(t('collectionControl.failed')); }); } }] : []),
              songMarkAction(track, savedEntries, () => epoch, () => !current(), sync, () => { if (current()) setError(t('common.loadFailed')); }),
              { label: t('trackActions.addToPlaylist'), disabled: !current(), onSelect: () => { if (current()) openNativePlaylistPicker(track, () => snapshot()?.playlists ?? {}, current, sync, () => snapshot()?.settings?.playlist_order); } },
              ...(track.source !== 'preview' ? [{ label: t('trackActions.editData'), disabled: !current(), onSelect: () => {
                if (current()) openNativeMetadataEditor(track, current, sync, id => snapshot()?.tracks.find(row => row.id === id), saved => runtime.execute({ action: 'metadata', tracks: [{ id: saved.id, title: saved.title, artist: saved.artist, album: saved.album ?? '', album_artist: saved.album_artist ?? null, album_id: saved.album_id ?? null, artist_id: saved.artist_id ?? null }] }));
              } }] : []),
              ...(context ? nativePlaylistOccurrenceActions(context.playlist, context.index, () => snapshot() ?? { tracks: [] }, current, sync, () => { if (current()) setError(t('common.loadFailed')); }) : []),
              ...(track.source !== 'preview' && !isPodcastTrack(track) ? [nativeFileDeletionAction(track, fileDeletion, current)] : []),
              ...offlineActions([track], offlineState, offlineCommand, () => generation)] }, event);
          }} />
          </Show></>}
      </Show>
    </Show>
    <OverlayOutlet /><ContextMenuOutlet /><ToastOutlet />
  </main>;
}
