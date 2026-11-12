import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js';
import { ScrobblingView } from '../components/ScrobblingView';
import { t } from '../lib/i18n';
import { createScrobbling } from '../lib/scrobbling';

/**
 * The web's scrobbling settings over the native transport. Scrobbling itself
 * needs nothing from this app: the engine reads the playback state the native
 * player already publishes.
 */
export default function NativeSettingsScrobbling(props: { identity: () => number; available: () => boolean }) {
  const [loading, setLoading] = createSignal(false), [failed, setFailed] = createSignal(false);
  let epoch = 0, disposed = false, scope: { signal: AbortSignal; current: () => boolean } | undefined;
  // An answer for an account or server this screen no longer shows is dropped.
  const scrobbling = createScrobbling({ owner: () => scope });
  async function load() {
    const owner = scope; if (!owner?.current() || loading()) return;
    setLoading(true); setFailed(false);
    try { await scrobbling.load(); }
    catch { if (owner.current()) setFailed(true); }
    finally { if (owner.current()) setLoading(false); }
  }
  createEffect(on(() => [props.identity(), props.available()] as const, ([identity]) => {
    const revision = ++epoch, controller = new AbortController();
    scrobbling.reset(); setLoading(false); setFailed(false);
    scope = { signal: controller.signal, current: () => !disposed && revision === epoch && identity === props.identity() && props.available() && !controller.signal.aborted };
    void load(); onCleanup(() => controller.abort());
  }));
  onCleanup(() => { disposed = true; epoch++; });
  return <section data-testid="android-settings-scrobbling" aria-busy={loading() || scrobbling.busy()}>
    <h2>{t('scrobbling.title')}</h2>
    <Show when={scrobbling.status()} fallback={<>
      <Show when={loading()}><p role="status">{t('common.loading')}</p></Show>
      <Show when={!props.available()}><p role="status">{t('library.unreachable')}</p></Show>
    </>}>{status => <ScrobblingView status={status()} busy={scrobbling.busy() || loading()} unavailable={!props.available()} lastfmUrl={scrobbling.lastfmUrl()}
      onConnect={service => void scrobbling.connect(service)} onCustomListenBrainz={() => void scrobbling.connectListenBrainz(true)}
      onFinishLastfm={() => void scrobbling.finishLastfm()} onToggle={service => void scrobbling.toggle(service)}
      onRetry={service => void scrobbling.retry(service)} onDisconnect={service => void scrobbling.disconnect(service)}
      onLastfmApp={() => void scrobbling.setLastfmApp()} onRemoveLastfmApp={() => void scrobbling.removeLastfmApp()} />}</Show>
    <Show when={failed()}><p role="alert">{t('common.loadFailed')} <button disabled={loading() || !props.available()} onClick={() => void load()}>{t('common.retry')}</button></p></Show>
    <Show when={scrobbling.error()}><p role="alert">{scrobbling.error()}</p></Show>
  </section>;
}
