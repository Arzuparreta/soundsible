import Button from './Button';
import { createSignal, onCleanup, onMount, Show, type ParentProps } from 'solid-js';
import { t } from '../lib/i18n';
import { EmptyState } from './EmptyState';
import { SkeletonRows } from './Skeleton';

/** Settings remain reachable while their values load. Never offer made-up
 * defaults as editable server settings before the first successful read. */
export function SettingsLoad(props: ParentProps<{ load: () => Promise<void> }>) {
  const [loading, setLoading] = createSignal(true);
  const [failed, setFailed] = createSignal(false);
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const load = async () => {
    setLoading(true);
    setFailed(false);
    try { await props.load(); }
    catch { if (!disposed) setFailed(true); }
    finally { if (!disposed) setLoading(false); }
  };
  onMount(() => void load());
  return <Show when={!loading()} fallback={<SkeletonRows count={3} />}>
    <Show when={!failed()} fallback={<EmptyState tone="danger">
      {t('common.loadFailed')} <Button variant="secondary" onClick={() => void load()}>{t('common.retry')}</Button>
    </EmptyState>}>{props.children}</Show>
  </Show>;
}
