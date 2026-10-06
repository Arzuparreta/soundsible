import { createSignal, onCleanup } from 'solid-js';
import { request } from '../lib/http';
import type { LibraryScanStatus } from '../lib/api';
import { confirmDialog } from '../lib/confirm';
import { promptDialog } from '../lib/prompt';
import { toast } from '../lib/toast';
import { trackCount } from '../lib/format';
import { t } from '../lib/i18n';

/** Library maintenance for the signed-in account; every await re-checks that the account and connection are still the same. */
export function createNativeLibraryMaintenance(props: {
  identity: () => number; available: () => boolean; signal: AbortSignal; trackCount: () => number; sync: () => Promise<void>;
}, dialogs = { confirm: confirmDialog, prompt: promptDialog }, pollMs = 750) {
  const [busy, setBusy] = createSignal(false);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (props.signal.aborted) abort(); else props.signal.addEventListener('abort', abort, { once: true });
  let disposed = false;
  onCleanup(() => { disposed = true; controller.abort(); props.signal.removeEventListener('abort', abort); });
  async function run(work: (current: () => boolean) => Promise<void>) {
    if (busy() || disposed || !props.available() || controller.signal.aborted) return;
    const epoch = props.identity();
    const current = () => !disposed && !controller.signal.aborted && props.identity() === epoch && props.available();
    setBusy(true);
    try { await work(current); }
    finally { if (!disposed) setBusy(false); }
  }
  const post = <T>(path: string, body?: unknown, timeoutMs?: number) =>
    request<T>(path, { method: 'POST', body: body ?? {}, signal: controller.signal, timeoutMs });

  const reload = () => run(async current => {
    try { await props.sync(); } catch { if (current()) toast.error(t('common.loadFailed')); }
  });

  const rescan = () => run(async current => {
    const progress = toast.loading(t('settings.toast.scanning'));
    try {
      let status = await request<LibraryScanStatus>('/api/library/scan', { method: 'POST', body: {}, signal: controller.signal, timeoutMs: 15000 });
      while (current() && (status.state === 'queued' || status.state === 'scanning')) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        if (!current()) break;
        status = await request<LibraryScanStatus>(`/api/library/scan?t=${Date.now()}`, { signal: controller.signal, timeoutMs: 15000 });
      }
      if (!current()) { progress.dismiss(); return; }
      if (status.state !== 'completed') throw new Error(status.error || 'Library scan failed');
      await props.sync();
      if (!current()) { progress.dismiss(); return; }
      progress.update(status.failed > 0 ? 'error' : 'success', t('settings.toast.scanned', { added: status.added, updated: status.updated, failed: status.failed }));
    } catch {
      if (current()) progress.update('error', t('settings.toast.scanFailed')); else progress.dismiss();
    }
  });

  const cloudSync = () => run(async current => {
    const progress = toast.loading(t('settings.toast.syncing'));
    try {
      const receipt = await post<{ status?: string }>('/api/downloader/sync', undefined, 60000);
      if (receipt.status !== 'started') throw new Error('Sync not started');
      await props.sync();
      if (current()) progress.update('success', t('settings.toast.synced')); else progress.dismiss();
    } catch { if (current()) progress.update('error', t('settings.toast.syncFailed')); else progress.dismiss(); }
  });

  /** Two steps on purpose, as on the web: the scan reports, only the confirmed run rewrites files (and their ids). */
  const repair = () => run(async current => {
    const scan = toast.loading(t('settings.toast.repairScanning'));
    try {
      const receipt = await post<{ status?: string; dry_run?: boolean }>('/api/library/repair', { dry_run: true });
      if (receipt.status !== 'started' || receipt.dry_run !== true) throw new Error('Repair scan not started');
      if (!current()) { scan.dismiss(); return; }
      scan.update('success', t('settings.toast.repairScanned'));
    } catch { if (current()) scan.update('error', t('settings.toast.repairFailed')); else scan.dismiss(); return; }
    const accepted = await dialogs.confirm({ title: t('settings.repairTitle'), message: t('settings.repairMsg'), confirmLabel: t('settings.repairConfirm') }, current);
    if (!accepted || !current()) return;
    const progress = toast.loading(t('settings.toast.repairing'));
    try {
      const receipt = await post<{ status?: string; dry_run?: boolean }>('/api/library/repair', { dry_run: false });
      if (receipt.status !== 'started' || receipt.dry_run !== false) throw new Error('Repair not started');
      if (current()) progress.update('success', t('settings.toast.repaired')); else progress.dismiss();
    } catch { if (current()) progress.update('error', t('settings.toast.repairFailed')); else progress.dismiss(); }
  });

  const purge = () => run(async current => {
    const accepted = await dialogs.confirm({ title: t('settings.purgeTitle'), message: t('settings.purgeMsg'), confirmLabel: t('settings.purgeConfirm') }, current);
    if (!accepted || !current()) return;
    const progress = toast.loading(t('settings.toast.purging'));
    try {
      const receipt = await post<{ status?: string; removed?: number }>('/api/library/purge-missing', undefined, 60000);
      if (receipt.status !== 'success') throw new Error('Purge not confirmed');
      await props.sync();
      if (current()) progress.update('success', t('settings.toast.purged', { count: receipt.removed ?? 0 })); else progress.dismiss();
    } catch { if (current()) progress.update('error', t('settings.toast.purgeFailed')); else progress.dismiss(); }
  });

  const wipe = () => run(async current => {
    const accepted = await dialogs.confirm({ title: t('settings.emptyLibraryTitle'), message: t('settings.emptyLibraryMsg'), confirmLabel: t('settings.emptyLibraryConfirm'), danger: true }, current);
    if (!accepted || !current()) return;
    const count = props.trackCount();
    const typed = await dialogs.prompt({ title: t('settings.emptyLibraryTitle'), message: t('settings.emptyLibraryCountMsg', { count: trackCount(count) }),
      inputLabel: t('settings.emptyLibraryCountLabel'), confirmLabel: t('settings.emptyLibraryConfirm'), danger: true, match: String(count) }, current);
    if (typed === null || typed.trim() !== String(count) || !current()) return;
    const progress = toast.loading(t('settings.toast.emptying'));
    try {
      const receipt = await post<{ status?: string }>('/api/library/wipe', { confirm: 'CONFIRM' });
      if (receipt.status !== 'success') throw new Error('Wipe not confirmed');
      await props.sync();
      if (current()) progress.update('success', t('settings.toast.emptied')); else progress.dismiss();
    } catch { if (current()) progress.update('error', t('settings.toast.emptyFailed')); else progress.dismiss(); }
  });

  return { busy, reload, rescan, cloudSync, repair, purge, wipe };
}
