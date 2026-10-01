import { createSignal, onCleanup, onMount, Show, type Component } from 'solid-js';
import { t } from './i18n';

/** Cache a module, retain the mounted view, and permit retry after import failure. */
export function deferredComponent<P extends object>(load: () => Promise<{ default: Component<P> }>,
  recover: () => Promise<{ default: Component<P> }> = load, fallbackClass?: string): Component<P> {
  let cached: Component<P> | undefined;
  let flight: Promise<Component<P>> | undefined;
  return props => {
    const [view, setView] = createSignal(cached);
    const [failed, setFailed] = createSignal(false);
    let disposed = false;
    onCleanup(() => { disposed = true; });
    let attempts = 0;
    const retry = () => {
      attempts += 1;
      setFailed(false);
      flight ??= (attempts > 1 ? recover() : load()).then(module => cached = module.default).finally(() => { flight = undefined; });
      void flight.then(component => {
        if (!disposed) setView(() => component);
      }, () => {
        if (disposed) return;
        // A view failure must not reload the page and interrupt playback.
        setFailed(true);
      });
    };
    onMount(() => { if (!view()) retry(); });
    return <Show when={view()} keyed fallback={
      <div class={fallbackClass} role="status" aria-busy={!failed()}>
        <Show when={failed()} fallback={t('common.loading')}>
          {t('common.loadFailed')} <button type="button" onClick={retry}>{t('common.retry')}</button>
        </Show>
      </div>
    }>{View => <View {...props} />}</Show>;
  };
}
