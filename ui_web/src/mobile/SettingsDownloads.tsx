import { Show } from 'solid-js';
import { DownloadsSettingsView } from '../components/DownloadsSettingsView';
import { createNativeDownloaderSettings } from './downloaderSettings';
import { t } from '../lib/i18n';

export default function NativeSettingsDownloads(props: { identity: () => number; available: () => boolean }) {
  const state = createNativeDownloaderSettings(props);
  return <section data-testid="android-settings-downloads" aria-busy={state.loading() || state.busy()}>
    <h2>{t('settings.downloads')}</h2>
    <Show when={state.settings()} fallback={<>
      <Show when={state.loading()}><p role="status">{t('common.loading')}</p></Show>
      <Show when={!props.available()}><p role="status">{t('library.unreachable')}</p></Show>
    </>}>{settings => <DownloadsSettingsView {...settings()} disabled={state.busy() || state.loading() || !props.available()}
      onQuality={quality => void state.quality(quality)} onToggleYtdlp={() => void state.toggleYtdlp()} onToggleCurlCffi={() => void state.toggleCurlCffi()} />}</Show>
    <Show when={state.error()}><p role="alert">{state.error()} <button disabled={state.loading() || state.busy() || !props.available()} onClick={() => void state.load()}>{t('common.retry')}</button></p></Show>
  </section>;
}
