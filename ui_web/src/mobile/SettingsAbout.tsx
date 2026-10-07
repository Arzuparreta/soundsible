import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { AboutSettingsView } from '../components/AboutSettingsView';
import { ValueRow } from '../components/SettingsRows';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { nativeBuildInfo, type NativeBuildInfo } from './platform';

/** This app's build and the connected server's version; both read, never assumed. */
export default function NativeSettingsAbout(props: { identity: () => number; available: () => boolean; online: () => boolean }) {
  const [build, setBuild] = createSignal<NativeBuildInfo | null>(null), [engine, setEngine] = createSignal<string | null>(null);
  let disposed = false;
  onCleanup(() => { disposed = true; });
  onMount(() => { void nativeBuildInfo().then(info => { if (!disposed) setBuild(info); }).catch(() => {}); });
  createEffect(on(() => [props.identity(), props.available()] as const, ([identity, available]) => {
    const controller = new AbortController();
    setEngine(null);
    if (available) void request<{ version?: unknown }>('/api/health', { signal: controller.signal, timeoutMs: 8000 }).then(health => {
      if (!disposed && identity === props.identity() && typeof health.version === 'string') setEngine(health.version);
    }).catch(() => {});
    onCleanup(() => controller.abort());
  }));
  return <section data-testid="android-settings-about">
    <h2>{t('settings.about')}</h2>
    <AboutSettingsView online={props.online()} version={<span>{build() ? `${build()!.version} (${build()!.build})` : t('common.loading')}</span>}>
      <Show when={engine()}>{version => <ValueRow label={t('settings.engineVersion')} value={version()} />}</Show>
    </AboutSettingsView>
  </section>;
}
