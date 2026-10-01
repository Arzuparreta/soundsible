import { createSignal, onCleanup, onMount, Show, type Component } from 'solid-js';
import { t } from './i18n';

/** Cache a module, retain the mounted view, and permit retry after import failure. */
export function deferredComponent<P extends object>(load: () => Promise<{ default: Component<P> }>): Component<P> {
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
      flight ??= load().then(module => cached = module.default).finally(() => { flight = undefined; });
      void flight.then(component => {
        if (!disposed) setView(() => component);
      }, () => {
        if (disposed) return;
        // Browsers retain rejected module loads. A reload also recovers from
        // an old shell referring to chunks removed by a deployment.
        if (attempts > 1) window.location.reload();
        else setFailed(true);
      });
    };
    onMount(() => { if (!view()) retry(); });
    return <Show when={view()} keyed fallback={
      <div role="status" aria-busy={!failed()}>
        <Show when={failed()} fallback={t('common.loading')}>
          {t('common.loadFailed')} <button type="button" onClick={retry}>{t('common.retry')}</button>
        </Show>
      </div>
    }>{View => <View {...props} />}</Show>;
  };
}
