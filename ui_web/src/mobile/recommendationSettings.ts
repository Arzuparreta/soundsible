import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { request } from '../lib/http';
import { confirmDialog } from '../lib/confirm';
import { t } from '../lib/i18n';

/** Account-scoped learning preferences; no optimistic defaults or audio ownership. */
export function createNativeRecommendationSettings(props: { identity: () => number; available: () => boolean }, confirm = confirmDialog) {
  const [learning, setLearning] = createSignal<boolean | undefined>();
  const [loading, setLoading] = createSignal(false), [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(''), [resetDone, setResetDone] = createSignal(false);
  let epoch = 0, disposed = false;
  let scope: { signal: AbortSignal; current: () => boolean } | undefined;
  const verify = (value: { learning_enabled?: boolean }) => {
    if (typeof value.learning_enabled !== 'boolean') throw new Error('Missing learning confirmation');
    return value.learning_enabled;
  };
  async function load() {
    const owner = scope; if (!owner?.current() || loading() || busy()) return;
    setLoading(true); setError('');
    try {
      const value = await request<{ learning_enabled?: boolean }>('/api/discovery/settings', { signal: owner.signal });
      if (owner.current()) setLearning(verify(value));
    } catch { if (owner.current()) setError(t('common.loadFailed')); }
    finally { if (owner.current()) setLoading(false); }
  }
  createEffect(on(() => [props.identity(), props.available()] as const, ([identity]) => {
    const revision = ++epoch, controller = new AbortController();
    setLearning(undefined); setError(''); setResetDone(false); setLoading(false); setBusy(false);
    scope = { signal: controller.signal, current: () => !disposed && revision === epoch && identity === props.identity() && props.available() && !controller.signal.aborted };
    void load(); onCleanup(() => controller.abort());
  }));
  onCleanup(() => { disposed = true; epoch++; });
  async function mutate(work: (owner: NonNullable<typeof scope>) => Promise<void>) {
    const owner = scope; if (!owner?.current() || busy() || loading() || learning() === undefined) return;
    setBusy(true); setError(''); setResetDone(false);
    try { await work(owner); }
    catch { if (owner.current()) setError(t('settings.toast.notSaved')); }
    finally { if (owner.current()) setBusy(false); }
  }
  const toggle = () => mutate(async owner => {
    const next = !learning();
    const receipt = await request<{ learning_enabled?: boolean }>('/api/discovery/settings', { method: 'PATCH', body: { learning_enabled: next }, signal: owner.signal });
    if (!owner.current()) return;
    if (verify(receipt) !== next) throw new Error('Learning change rejected');
    const stored = await request<{ learning_enabled?: boolean }>('/api/discovery/settings', { signal: owner.signal });
    if (!owner.current()) return;
    const value = verify(stored); setLearning(value);
    if (value !== next) throw new Error('Learning setting changed');
  });
  const reset = () => mutate(async owner => {
    const accepted = await confirm({ title: t('settings.resetLearning'), message: t('settings.resetLearningConfirm'), confirmLabel: t('settings.resetLearning'), danger: true }, owner.current);
    if (!accepted || !owner.current()) return;
    const receipt = await request<{ status?: string }>('/api/discovery/profile', { method: 'DELETE', signal: owner.signal, timeoutMs: 5000 });
    if (!owner.current()) return;
    if (receipt.status !== 'reset') throw new Error('Missing reset confirmation');
    setResetDone(true);
  });
  return { learning, loading, busy, error, resetDone, load, toggle, reset };
}
