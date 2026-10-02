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
import logo from '../../../branding/logo-mark.svg';
import styles from './AndroidStart.module.css';

export default function AndroidStart() {
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
  let username: HTMLInputElement | undefined;
  let password: HTMLInputElement | undefined;
  let epoch = 0;
  let syncEpoch = 0;
  let cancelEvents: (() => void) | undefined;
  let controller = new AbortController();
  function reset() {
    epoch++; syncEpoch++; controller.abort(); controller = new AbortController();
    cancelEvents?.(); cancelEvents = undefined;
    setUser(null); registerArtworkMetadata([]); setSnapshot(null); setRevision(0); setEventsOnline(false); setStale(false);
  }
  async function sync() {
    if (!user()) return;
    const current = epoch;
    const job = ++syncEpoch;
    try {
      const state = await request<{ requires_login: boolean; user: User | null }>('/api/auth/state', { signal: controller.signal });
      if (current !== epoch || job !== syncEpoch) return;
      if (!state.user || (user() && user()!.id !== state.user.id)) { reset(); setNeedsLogin(true); return; }
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
      if (failure instanceof ApiError && failure.status === 401) { reset(); setNeedsLogin(true); }
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
    if (!state.user) return;
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
  async function refresh() {
    const current = epoch;
    await sync();
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
      useEngine(next); setServer(next.origin); setOrigin(next.origin);
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
      useEngine(await engine.clear({ forget }));
      if (forget) { setServer(''); setNeedsLogin(false); }
      else setNeedsLogin(true);
      setBusy(false);
    }
  }
  onMount(() => {
    setUnauthorizedHandler(() => { reset(); setNeedsLogin(true); });
    void engine.state().then(async state => {
      useEngine(state); setOrigin(state.origin); setServer(state.origin);
      if (state.origin) { setBusy(true); try { await resolveIdentity(); } catch { setError(t('android.connectFailed')); } finally { setBusy(false); } }
    }).finally(() => window.__SOUNDSIBLE_BOOT__?.complete());
    const interval = setInterval(() => { if (user() && document.visibilityState === 'visible') void sync(); }, 30000);
    const resume = () => { if (user() && document.visibilityState === 'visible') void sync(); };
    document.addEventListener('visibilitychange', resume);
    onCleanup(() => { clearInterval(interval); document.removeEventListener('visibilitychange', resume); reset(); setUnauthorizedHandler(null); });
  });
  return <main class={user() ? styles.connected : styles.start} data-testid={server() ? 'android-configured' : 'android-unconfigured'}>
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
    <Show when={user()}>
      <Show when={stale()}><p role="status">{t('library.unreachable')} <button onClick={() => void refresh()}>{t('common.retry')}</button></p></Show>
      <Show when={!eventsOnline()}><p class={styles.notice}>{t('android.eventsPending')}</p></Show>
      <Show when={snapshot()} fallback={<button onClick={() => void refresh()}>{t('common.retry')}</button>}>
        {data => <LibraryBrowser snapshot={data()} revision={revision()} />}
      </Show>
    </Show>
  </main>;
}
