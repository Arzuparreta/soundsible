import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { CommunitySettingsView } from '../components/CommunitySettingsView';
import type { CommunityConfig } from '../lib/community';
import { request } from '../lib/http';
import { t } from '../lib/i18n';

/** The server's relay configuration as the server reports it; read-only. */
export default function NativeSettingsCommunity(props: { identity: () => number; available: () => boolean }) {
  const [config, setConfig] = createSignal<CommunityConfig | null>(null), [loading, setLoading] = createSignal(false);
  let epoch = 0, disposed = false, scope: { signal: AbortSignal; current: () => boolean } | undefined;
  async function load() {
    const owner = scope; if (!owner?.current() || loading()) return;
    setLoading(true);
    try {
      const value = await request<CommunityConfig>('/api/community/config', { signal: owner.signal, timeoutMs: 10000 });
      if (owner.current()) setConfig(typeof value?.source === 'string' && typeof value.state === 'string' ? value : null);
    } catch { if (owner.current()) setConfig(null); }
    finally { if (owner.current()) setLoading(false); }
  }
  createEffect(on(() => [props.identity(), props.available()] as const, ([identity]) => {
    const revision = ++epoch, controller = new AbortController();
    setConfig(null); setLoading(false);
    scope = { signal: controller.signal, current: () => !disposed && revision === epoch && identity === props.identity() && props.available() && !controller.signal.aborted };
    void load(); onCleanup(() => controller.abort());
  }));
  onCleanup(() => { disposed = true; epoch++; });
  return <section data-testid="android-settings-community" aria-busy={loading()}>
    <h2>{t('settings.community')}</h2>
    <CommunitySettingsView config={config()} loading={loading()} disabled={!props.available()} onRetry={() => void load()} />
  </section>;
}
