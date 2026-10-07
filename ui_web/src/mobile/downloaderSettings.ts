import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { request } from '../lib/http';
import { DOWNLOAD_QUALITIES, type DownloaderSettings, type DownloadQuality } from '../components/DownloadsSettingsView';
import { t } from '../lib/i18n';

interface DownloaderConfig { quality?: string; auto_update_ytdlp?: boolean; auto_update_curl_cffi?: boolean }

/** Instance downloader preferences (admin): shown only after a confirmed read, changed only when the server echoes the change back. */
export function createNativeDownloaderSettings(props: { identity: () => number; available: () => boolean }) {
  const [settings, setSettings] = createSignal<DownloaderSettings | undefined>();
  const [loading, setLoading] = createSignal(false), [busy, setBusy] = createSignal(false), [error, setError] = createSignal('');
  let epoch = 0, disposed = false;
  let scope: { signal: AbortSignal; current: () => boolean } | undefined;
  const parse = (value: DownloaderConfig): DownloaderSettings => {
    if (!DOWNLOAD_QUALITIES.includes(value.quality as DownloadQuality) || typeof value.auto_update_ytdlp !== 'boolean' || typeof value.auto_update_curl_cffi !== 'boolean') throw new Error('Incomplete downloader settings');
    return { quality: value.quality as DownloadQuality, autoUpdateYtdlp: value.auto_update_ytdlp, autoUpdateCurlCffi: value.auto_update_curl_cffi };
  };
  async function load() {
    const owner = scope; if (!owner?.current() || loading() || busy()) return;
    setLoading(true); setError('');
    try {
      const value = parse(await request<DownloaderConfig>('/api/downloader/config', { signal: owner.signal }));
      if (owner.current()) setSettings(value);
    } catch { if (owner.current()) setError(t('common.loadFailed')); }
    finally { if (owner.current()) setLoading(false); }
  }
  createEffect(on(() => [props.identity(), props.available()] as const, ([identity]) => {
    const revision = ++epoch, controller = new AbortController();
    setSettings(undefined); setError(''); setLoading(false); setBusy(false);
    scope = { signal: controller.signal, current: () => !disposed && revision === epoch && identity === props.identity() && props.available() && !controller.signal.aborted };
    void load(); onCleanup(() => controller.abort());
  }));
  onCleanup(() => { disposed = true; epoch++; });
  async function change(patch: Partial<DownloaderConfig>, expected: (value: DownloaderSettings) => boolean) {
    const owner = scope; if (!owner?.current() || busy() || loading() || !settings()) return;
    setBusy(true); setError('');
    try {
      const receipt = await request<{ status?: string }>('/api/downloader/config', { method: 'POST', body: patch, signal: owner.signal });
      if (!owner.current()) return;
      if (receipt.status !== 'updated') throw new Error('Downloader change rejected');
      const stored = parse(await request<DownloaderConfig>('/api/downloader/config', { signal: owner.signal }));
      if (!owner.current()) return;
      setSettings(stored);
      if (!expected(stored)) throw new Error('Downloader setting changed');
    } catch { if (owner.current()) setError(t('settings.toast.notSaved')); }
    finally { if (owner.current()) setBusy(false); }
  }
  const quality = (next: DownloadQuality) => settings()?.quality === next ? Promise.resolve() : change({ quality: next }, value => value.quality === next);
  const toggleYtdlp = () => { const next = !settings()?.autoUpdateYtdlp; return change({ auto_update_ytdlp: next }, value => value.autoUpdateYtdlp === next); };
  const toggleCurlCffi = () => { const next = !settings()?.autoUpdateCurlCffi; return change({ auto_update_curl_cffi: next }, value => value.autoUpdateCurlCffi === next); };
  return { settings, loading, busy, error, load, quality, toggleYtdlp, toggleCurlCffi };
}
