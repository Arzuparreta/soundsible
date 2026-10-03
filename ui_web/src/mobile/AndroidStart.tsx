import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { t } from '../lib/i18n';
import { musicLibraryRows } from '../lib/musicLibrary';
import { buildIdentityIndex } from '../lib/playbackIdentity';
import { savedToTrack } from '../lib/saved';
import type { SavedEntry, Track } from '../types/music';
import { registerArtworkMetadata } from '../lib/media';
import { ApiError, request, setUnauthorizedHandler } from '../lib/http';
import type { User } from '../lib/session';
import { engine, useEngine, watchEngine } from './engine';
import LibraryBrowser, { type BrowseSnapshot } from './LibraryBrowser';
import { nativeProgramTransport, mixedProgram } from './playback';
import { createProgramRuntime, type ProgramState } from '../lib/program/runtime';
import ProgramTransport from '../components/ProgramTransport';
import { openContextMenu, ContextMenuOutlet } from '../lib/contextMenu';
import { OverlayOutlet } from '../lib/overlay';
import { programLibraryMenu } from '../lib/program/libraryMenu';
import ProgramQueue from '../components/ProgramQueue';
import { offline, availableLibrary, availableProgram, type OfflineState, type OfflineCommand } from './offline';
import { offlineActions, openOfflineManager } from './OfflineManager';
import logo from '../../../branding/logo-mark.svg';
import styles from './AndroidStart.module.css';

export default function AndroidStart() {
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
  const [revision, setRevision] = createSignal(0);
  const [offlineState, setOfflineState] = createSignal<OfflineState | null>(null);
  async function offlineCommand(command: OfflineCommand) {
    const current = epoch;
    try {
      const result = await offline.command({ ...command, ...(command.action === 'prepare' ? { playlists: snapshot()?.playlists ?? command.playlists } : {}), generation });
      if (current === epoch) {
        const lostProfile = !result.user && !!offlineState()?.user && !!user();
        if (JSON.stringify(result) !== JSON.stringify(offlineState())) setOfflineState(result);
        if (lostProfile) await expireSession();
      }
    } catch { if (current === epoch) setError(t('android.offlineFailed')); }
  }
  async function restoreOffline() {
    const current = epoch;
    const result = await offline.command({ action: 'state', generation });
    if (current !== epoch) return;
    setOfflineState(result);
    if (result.user && result.items.length) { setUser(result.user); setSnapshot(availableLibrary(result)); setStale(true); }
  }
  let username: HTMLInputElement | undefined;
  let password: HTMLInputElement | undefined;
  let epoch = 0;
  let syncEpoch = 0;
  let cancelEvents: (() => void) | undefined;
  let controller = new AbortController();
  function reset(stopPlayback = true) {
    epoch++; syncEpoch++; controller.abort(); controller = new AbortController();
    cancelEvents?.(); cancelEvents = undefined;
    if (stopPlayback) {
      const active = program();
      if (active?.queue.length) void nativeProgramTransport.command({ generation, action: 'stop', queueToken: active.queueToken }).catch(() => {});
      runtime.unbind();
    }
    setOfflineState(null); setProgram(null); setUser(null); registerArtworkMetadata([]); setSnapshot(null); setRevision(0); setEventsOnline(false); setStale(false);
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
  async function sync() {
    if (!user()) return;
    const current = epoch;
    const job = ++syncEpoch;
    try {
      const state = await request<{ requires_login: boolean; user: User | null }>('/api/auth/state', { signal: controller.signal });
      if (current !== epoch || job !== syncEpoch) return;
      if (!state.user || (user() && user()!.id !== state.user.id)) { await expireSession(); return; }
      const [data, saved] = await Promise.all([
        request<BrowseSnapshot>('/api/library', { timeoutMs: 30000, signal: controller.signal, cache: 'no-store' }),
        request<{ saved: SavedEntry[] }>('/api/library/saved', { signal: controller.signal, cache: 'no-store' }),
      ]);
      if (current !== epoch || job !== syncEpoch) return;
      if (!Array.isArray(data.tracks)) throw new Error('Invalid library');
      if (!Array.isArray(saved.saved)) throw new Error('Invalid saved-song snapshot');
      const index = buildIdentityIndex(data.tracks);
      const resolved = saved.saved.map(entry => savedToTrack(entry, index)).filter((track): track is Track => !!track);
      setSnapshot({ ...data, tracks: musicLibraryRows(data.tracks, resolved) }); setRevision(n => n + 1); setStale(false); setError('');
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
  onMount(() => {
    setUnauthorizedHandler(() => { void expireSession(); });
    void engine.state().then(state => {
      generation = state.generation; useEngine(state); void runtime.bind(generation); setOrigin(state.origin); setServer(state.origin);
      if (state.origin) void restoreOffline().catch(() => {}).then(() => revalidateIdentity());
    }).finally(() => window.__SOUNDSIBLE_BOOT__?.complete());
    let lastOfflinePoll = 0;
    const offlineInterval = setInterval(() => {
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
    <Show when={program()?.queue.length ? program() : null}>{state => <><ProgramTransport state={state()} pending={programPending()} command={runtime.execute} /><ProgramQueue state={state()} pending={programPending()} command={runtime.execute} /></>}</Show>
    <Show when={user()}>
      <Show when={stale()}><p role="status">{t('library.unreachable')} <button onClick={() => void refresh()}>{t('common.retry')}</button></p></Show>
      <Show when={!eventsOnline() && !stale()}><p class={styles.notice}>{t('android.eventsPending')}</p></Show>
      <Show when={snapshot()} fallback={<button onClick={() => void refresh()}>{t('common.retry')}</button>}>
        {data => <LibraryBrowser snapshot={data()} revision={revision()} disconnected={stale()} offline={offlineState()} activeId={program()?.id} onPlay={play}
          onManageOffline={() => { const captured = generation; openOfflineManager(offlineState, command => captured === generation ? offlineCommand(command) : Promise.resolve()); }}
          onCollectionMenu={(tracks, title, event) => openContextMenu({ title, actions: offlineActions(tracks, offlineState, offlineCommand, () => generation) }, event)}
          onMenu={(track, event) => { const menu = programLibraryMenu(track, program, programPending, runtime.execute); openContextMenu({ ...menu, actions: [...(menu.actions ?? []), ...offlineActions([track], offlineState, offlineCommand, () => generation)] }, event); }} />}
      </Show>
    </Show>
    <OverlayOutlet /><ContextMenuOutlet />
  </main>;
}
