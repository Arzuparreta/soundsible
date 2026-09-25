import Button from './Button';
import { createSignal, ErrorBoundary, onCleanup, onMount, Show, type Component } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { t } from '../lib/i18n';
import { ViewHeader } from './ViewHeader';
import { SkeletonCards, SkeletonRows } from './Skeleton';
import { EmptyState } from './EmptyState';

/** Route modules load independently of router transitions. The destination and
 * its header commit immediately; a slow chunk never keeps the old page alive.
 * Cache code, not mounted pages or account data. Failed imports remain retryable. */
export function asyncPage(load: () => Promise<{ default: Component }>, title: () => string,
  shape: 'rows' | 'cards' = 'rows'): Component {
  let cached: Component | undefined;
  let flight: Promise<Component> | undefined;
  const resolve = () => flight ??= load().then(module => cached = module.default)
    .finally(() => { flight = undefined; });
  return () => {
    const [page, setPage] = createSignal<Component | undefined>(cached);
    const [failed, setFailed] = createSignal(false);
    let disposed = false;
    onCleanup(() => { disposed = true; });
    const retry = () => {
      setFailed(false);
      void resolve().then(component => {
        if (!disposed) setPage(() => component);
      }, () => { if (!disposed) setFailed(true); });
    };
    onMount(() => { if (!page()) retry(); });
    return <Show when={page()} keyed fallback={
      <div class="view">
        <ViewHeader title={title()} />
        <Show when={!failed()} fallback={<EmptyState tone="danger">
          {t('common.loadFailed')} <Button variant="secondary" onClick={retry}>{t('common.retry')}</Button>
        </EmptyState>}>
          <div class="page-loading" aria-busy="true">
            <Show when={shape === 'cards'} fallback={<SkeletonRows />}><SkeletonCards /></Show>
          </div>
        </Show>
      </div>
    }>{component => <ErrorBoundary fallback={(_error, reset) => <div class="view">
      <ViewHeader title={title()} />
      <EmptyState tone="danger">{t('common.loadFailed')} <Button variant="secondary" onClick={reset}>{t('common.retry')}</Button></EmptyState>
    </div>}><Dynamic component={component} /></ErrorBoundary>}</Show>;
  };
}
