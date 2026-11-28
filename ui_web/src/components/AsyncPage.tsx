import Button from './Button';
import { createSignal, ErrorBoundary, onCleanup, onMount, Show, type Component } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { t } from '../lib/i18n';
import { ViewHeader } from './ViewHeader';
import { EmptyState } from './EmptyState';

async function hasNewerWebBuild(): Promise<boolean> {
  if (window.location.pathname !== '/player/') return false;
  const current = document.querySelector<HTMLMetaElement>('meta[name="soundsible-build"]')?.content;
  if (!current) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // A fetch for the shell bypasses the service worker's navigation fallback.
    const response = await fetch('/player/', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return false;
    const latest = (await response.text()).match(/<meta name="soundsible-build" content="([a-f0-9]{64})"/i)?.[1];
    return !!latest && latest !== current;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Route modules load independently of router transitions. The destination and
 * its header commit immediately; a slow chunk never keeps the old page alive.
 * Cache code, not mounted pages or account data. */
export function asyncPage(load: () => Promise<{ default: Component }>, title: () => string): Component {
  let cached: Component | undefined;
  let flight: Promise<Component> | undefined;
  const resolve = () => flight ??= load().then(module => cached = module.default)
    .finally(() => { flight = undefined; });
  return () => {
    const [page, setPage] = createSignal<Component | undefined>(cached);
    const [failure, setFailure] = createSignal<'retry' | 'reload'>();
    let disposed = false;
    onCleanup(() => { disposed = true; });
    const retry = () => {
      setFailure(undefined);
      void resolve().then(component => {
        if (!disposed) setPage(() => component);
      }, async () => {
        if (disposed) return;
        const updated = await hasNewerWebBuild();
        if (!disposed) setFailure(updated ? 'reload' : 'retry');
      });
    };
    onMount(() => { if (!page()) retry(); });
    return <Show when={page()} keyed fallback={
      <div class="view">
        <ViewHeader title={title()} />
        <Show when={!failure()} fallback={<EmptyState tone="danger">
          <Show when={failure() === 'reload'} fallback={<>
            {t('common.loadFailed')} <Button variant="secondary" onClick={retry}>{t('common.retry')}</Button>
          </>}>
            {t('common.updatedPage')} <Button variant="secondary" onClick={() => window.location.reload()}>{t('common.reload')}</Button>
          </Show>
        </EmptyState>}>
          <div class="route-loading" role="status">{t('common.loading')}</div>
        </Show>
      </div>
    }>{component => <ErrorBoundary fallback={(_error, reset) => <div class="view">
      <ViewHeader title={title()} />
      <EmptyState tone="danger">{t('common.loadFailed')} <Button variant="secondary" onClick={reset}>{t('common.retry')}</Button></EmptyState>
    </div>}><Dynamic component={component} /></ErrorBoundary>}</Show>;
  };
}
