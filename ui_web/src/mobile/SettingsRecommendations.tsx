import { Show } from 'solid-js';
import { RecommendationSettingsView } from '../components/RecommendationSettingsView';
import { createNativeRecommendationSettings } from './recommendationSettings';
import { t } from '../lib/i18n';
import NativeSettingsLinkStatus from './SettingsLinkStatus';

export default function NativeSettingsRecommendations(props: { identity: () => number; available: () => boolean }) {
  const state = createNativeRecommendationSettings(props);
  return <section data-testid="android-recommendation-settings" aria-busy={state.loading() || state.busy()}>
    <Show when={state.learning() !== undefined} fallback={<>
      <Show when={state.loading()}><p role="status">{t('common.loading')}</p></Show>
      <Show when={!props.available()}><p role="status">{t('library.unreachable')}</p></Show>
    </>}>
      <RecommendationSettingsView learning={state.learning()!} disabled={state.busy() || state.loading() || !props.available()}
        onToggle={() => void state.toggle()} onReset={() => void state.reset()} />
    </Show>
    <Show when={state.error()}><p role="alert">{state.error()} <button disabled={state.loading() || state.busy() || !props.available()} onClick={() => void state.load()}>{t('common.retry')}</button></p></Show>
    <Show when={state.resetDone()}><p role="status">{t('settings.resetLearningDone')}</p></Show>
    <NativeSettingsLinkStatus identity={props.identity} available={props.available} />
  </section>;
}
