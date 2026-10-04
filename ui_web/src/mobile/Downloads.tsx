import { createSignal, createEffect, on, For, Show } from 'solid-js';
import { DownloadRowView } from '../components/DownloadRowView';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import type { DownloadQueueItem } from '../types/download';
import styles from './AndroidStart.module.css';

/** Server-owned jobs; writes wait for a confirmed, refreshed account snapshot. */
export default function NativeDownloads(props: { items: DownloadQueueItem[]; disconnected: boolean; generation: number; onChanged(): Promise<void> }) {
  const [pending, setPending] = createSignal<string[]>([]);
  const [error, setError] = createSignal(false);
  createEffect(on(() => props.generation, () => { setPending([]); setError(false); }));
  async function mutate(id: string, kind: 'retry' | 'remove' | 'clear' | 'clearFailed') {
    if (props.disconnected || pending().includes(id)) return;
    const generation = props.generation;
    const current = () => generation === props.generation && !props.disconnected;
    setPending(ids => [...ids, id]); setError(false);
    try {
      const suffix = kind === 'clear' ? '' : kind === 'clearFailed' ? '/failed' : `/${encodeURIComponent(id)}${kind === 'retry' ? '/retry' : ''}`;
      const reply = await request<{ status: string; item?: DownloadQueueItem }>(`/api/downloader/queue${suffix}`, { method: kind === 'retry' ? 'POST' : 'DELETE', timeoutMs: 15000 });
      if (!current()) return;
      const expected = kind === 'retry' ? 'retried' : kind === 'remove' ? 'removed' : 'cleared';
      if (reply.status !== expected || (kind === 'retry' && reply.item?.id !== id)) throw new Error('Missing job confirmation');
      await props.onChanged();
      if (current() && kind === 'clear' && props.items.some(row => ['pending', 'failed', 'interrupted'].includes(row.status))) throw new Error('Queue clearing not observed');
      if (current() && kind === 'clearFailed' && props.items.some(row => ['failed', 'interrupted'].includes(row.status))) throw new Error('Failed jobs clearing not observed');
      if (current() && kind === 'remove' && props.items.some(row => row.id === id)) throw new Error('Job removal not observed');
    } catch { if (current()) setError(true); }
    finally { if (current()) setPending(ids => ids.filter(row => row !== id)); }
  }
  return <section class={styles.library} data-testid="android-downloads">
    <h2>{t('downloads.title')}</h2>
    <Show when={props.disconnected}><p role="status">{t('library.unreachable')}</p></Show>
    <Show when={error()}><p role="alert">{t('common.loadFailed')} <button onClick={() => void props.onChanged()}>{t('common.retry')}</button></p></Show>
    <For each={props.items} fallback={<p>{t('downloads.emptyTitle')}</p>}>{item => <DownloadRowView item={item}
      disabled={props.disconnected || pending().length > 0} retry={id => void mutate(id, 'retry')} remove={id => void mutate(id, 'remove')} />}</For>
    <Show when={props.items.some(row => row.status === 'failed' || row.status === 'interrupted')}><button disabled={props.disconnected || pending().length > 0} onClick={() => void mutate('__failed', 'clearFailed')}>{t('downloads.clearErrors')}</button></Show>
    <Show when={props.items.some(row => row.status !== 'downloading')}><button disabled={props.disconnected || pending().length > 0} onClick={() => void mutate('__all', 'clear')}>{t('downloads.clearQueue')}</button></Show>
  </section>;
}
