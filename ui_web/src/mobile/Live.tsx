import { createEffect, createSignal, onMount, onCleanup, For, Show } from 'solid-js';
import { nativeLive, type NativeLiveState, type NativeLiveCommand } from './live';
import { t } from '../lib/i18n';
import { openOverlay } from '../lib/overlay';
import type { CommunityConfig, LiveSession } from '../lib/community';
import styles from './Live.module.css';
import { nativeShareLive } from './share';
import { liveArtworkUrl } from './livePresentation';
import type { LiveDeck } from '../lib/community';

export function NativeLive(props: { generation: () => number; current: () => boolean; username: string; onAuthExpired?: () => void }) {
  const [state, setState] = createSignal<NativeLiveState | null>(null);
  const [config, setConfig] = createSignal<CommunityConfig | null>(null);
  const [rooms, setRooms] = createSignal<LiveSession[]>([]);
  const [title, setTitle] = createSignal(`Session by ${props.username}`);
  const [text, setText] = createSignal('');
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal(false);
  let alive = true, refreshSequence = 0, refreshing = false;
  let refreshTimer: number | undefined;
  let listener: { remove(): Promise<void> } | undefined;
  const failed = (error: unknown) => { if (valid()) { if ((error as { code?: string })?.code === 'AUTH_EXPIRED') props.onAuthExpired?.(); else setError(true); } };
  const valid = () => alive && props.current();
  const accept = (next: NativeLiveState) => { if (valid() && next.generation === props.generation()) setState(next); };
  const host = () => state()?.host?.session ? state()?.host : null;
  const listening = () => state()?.listener?.session ? state()?.listener : null;
  const room = () => host() ?? listening();
  async function refresh() {
    if (!valid() || refreshing) return;
    refreshing = true;
    const sequence = ++refreshSequence;
    try {
      const data = await nativeLive.liveDirectory({ generation: props.generation() });
      if (!valid() || sequence !== refreshSequence) return;
      const selected = data.config;
      setConfig(selected);
      if (selected.state !== 'available' || !selected.api_url) { setRooms([]); return; }
      if (!Array.isArray(data.sessions) || data.sessions.length > 100 || data.sessions.some(entry =>
        typeof entry?.id !== 'string' || typeof entry?.title !== 'string' || typeof entry?.host?.display_name !== 'string' || typeof entry?.whep_url !== 'string')) throw new Error('Invalid directory');
      if (valid() && sequence === refreshSequence) { setRooms(data.sessions); setError(false); }
    } catch (error) { if (valid() && sequence === refreshSequence) failed(error); }
    finally { refreshing = false; }
  }
  async function command(next: Omit<NativeLiveCommand, 'generation'>) {
    if (!valid() || busy()) return;
    setBusy(true); setError(false);
    try {
      accept(await nativeLive.liveCommand({ ...next, generation: props.generation() }));
      if (['liveStart', 'liveStop', 'liveTitle', 'liveLeave'].includes(next.action)) void refresh();
      return true;
    }
    catch (error) { failed(error); return false; }
    finally { if (valid()) setBusy(false); }
  }
  async function share(session: LiveSession) {
    if (!valid() || busy()) return;
    setBusy(true);
    try { await nativeShareLive(session, props.generation, valid); }
    catch (error) { failed(error); }
    finally { if (valid()) setBusy(false); }
  }
  function Deck(props: { deck: LiveDeck; roomId: string; secondary?: boolean }) {
    const artwork = () => liveArtworkUrl(props.deck.artwork_url, config()?.api_url, props.roomId);
    return <div class={styles.deck} data-native-live-deck={props.secondary ? 'secondary' : 'primary'}>
      <Show when={artwork()}>{url => <img src={url()} alt="" loading="lazy" />}</Show>
      <div><strong>{props.deck.title}</strong><p>{props.deck.artist}</p></div>
    </div>;
  }
  onMount(() => {
    void nativeLive.addListener('nativeLiveState', accept).then(handle => { if (valid()) listener = handle; else void handle.remove(); });
    void nativeLive.liveState().then(accept).catch(() => { if (valid()) setError(true); });
    void refresh();
    refreshTimer = window.setInterval(() => { if (valid() && document.visibilityState === 'visible') void refresh(); }, 10000);
  });
  onCleanup(() => { alive = false; window.clearInterval(refreshTimer); void listener?.remove(); });
  return <section class={styles.panel} data-native-live>
    <Show when={error()}><p role="status">{t('live.unavailable')}</p></Show>
    <Show when={host()} fallback={<form onSubmit={event => { event.preventDefault(); void command({ action: 'liveStart', title: title() }); }}>
      <label>{t('common.rename')}<input aria-label={t('common.rename')} value={title()} maxLength={120} onInput={event => setTitle(event.currentTarget.value)} /></label>
      <button disabled={busy() || !state()?.ready || config()?.state !== 'available' || !!listening()}>{t('live.goLive')}</button>
    </form>}>{active => <section>
      <h3>{active().session!.title}</h3>
      <p role="status">{active().connected ? t('live.onAir') : t('live.connectingAudio')}</p>
      <form onSubmit={event => { event.preventDefault(); void command({ action: 'liveTitle', title: title() }); }}>
        <label>{t('common.rename')}<input aria-label={t('common.rename')} value={title()} maxLength={120} onInput={event => setTitle(event.currentTarget.value)} /></label>
        <button disabled={busy()}>{t('common.save')}</button>
      </form>
      <button disabled={busy()} onClick={() => void command({ action: 'liveStop' })}>{t('live.end')}</button>
    </section>}</Show>
    <Show when={listening()}>{active => <section>
      <h3>{active().session!.title}</h3>
      <button disabled={busy()} onClick={() => void command({ action: active().playing ? 'livePause' : 'liveResume' })}>{active().playing ? t('common.pause') : t('common.play')}</button>
      <label>{t('omnibar.volume')}<input aria-label={t('omnibar.volume')} type="range" disabled={busy()} min="0" max="1" step="0.05" value={active().volume ?? 1} onChange={event => void command({ action: 'liveVolume', volume: Number(event.currentTarget.value) })} /></label>
      <button disabled={busy()} onClick={() => void command({ action: 'liveLeave' })}>{t('live.leave')}</button>
    </section>}</Show>
    <Show when={room()}>{active => <section aria-label={t('live.chat')}>
      <Show when={active().program?.primary} fallback={<p>{t('live.waiting')}</p>}>
        {deck => <Deck deck={deck()} roomId={active().session!.id} />}
      </Show>
      <Show when={active().program?.transport === 'paused'}><p role="status">{t('live.breakHint')}</p></Show>
      <Show when={active().program?.secondary}>{deck => <>
        <Deck deck={deck()} roomId={active().session!.id} secondary />
        <Show when={active().program?.transition}>{mix => <label class={styles.transition}>
          {mix().technique.replaceAll('_', ' ')}
          <progress aria-label={mix().technique.replaceAll('_', ' ')} max="1" value={Math.max(0, Math.min(1, mix().progress))} />
        </label>}</Show>
      </>}</Show>
      <button disabled={busy()} onClick={() => void share(active().session!)}>{t('live.share')}</button>
      <p>{t('live.listeners', { count: active().session!.listener_count })}</p>
      <ul><For each={active().messages ?? []}>{message => <li><strong>{message.sender.display_name}: </strong>{message.text}</li>}</For></ul>
      <form onSubmit={event => { event.preventDefault(); void command({ action: 'liveChat', text: text() }).then(sent => { if (sent && valid()) setText(''); }); }}>
        <input aria-label={t('live.chat')} placeholder={t('live.chatPlaceholder')} value={text()} maxLength={500} onInput={event => setText(event.currentTarget.value)} />
        <button disabled={busy() || !text().trim()}>{t('live.send')}</button>
      </form>
    </section>}</Show>
    <div class={styles.directory}><h3>{t('live.directory')}</h3><button disabled={busy()} onClick={() => void refresh()}>{t('live.refresh')}</button></div>
    <Show when={rooms().length} fallback={<p>{config()?.state === 'available' ? t('live.empty') : t('live.unavailable')}</p>}>
      <ul><For each={rooms()}>{entry => <li><strong>{entry.title}</strong> · {entry.host.display_name}
        <button disabled={busy() || entry.id === host()?.session?.id} onClick={() => {
          const origin = config()?.api_url;
          if (origin) void command({ action: 'liveListen', session: { ...entry, api_url: origin, guest_name: props.username } });
        }}>{entry.id === listening()?.session?.id ? t('live.listening') : t('live.listen')}</button>
      </li>}</For></ul>
    </Show>
  </section>;
}

export function openNativeLive(generation: () => number, current: () => boolean, username: string, onAuthExpired?: () => void) {
  if (!current()) return;
  return openOverlay(close => { createEffect(() => { if (!current()) close(); }); return <><header class={styles.header}><h2>{t('live.title')}</h2><button onClick={() => close()}>{t('common.close')}</button></header>
    <NativeLive generation={generation} current={current} username={username} onAuthExpired={onAuthExpired} /></>; }, { ariaLabel: () => t('live.title'), variant: 'window' });
}
