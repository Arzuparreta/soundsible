import { Show } from 'solid-js';
import { SubsonicAccessView } from '../components/SubsonicAccessView';
import { createNativeSubsonicAccess } from './subsonicAccess';
import { t } from '../lib/i18n';

type Props = Parameters<typeof createNativeSubsonicAccess>[0] & { copy?: (value: string, sensitive: boolean) => Promise<boolean> };
export default function NativeSettingsSubsonic(props: Props) {
  const state = createNativeSubsonicAccess(props, undefined, props.copy);
  return <section data-testid="android-subsonic-settings" aria-busy={state.loading() || state.busy()}>
    <Show when={state.access()} fallback={<>
      <Show when={state.loading()}><p role="status">{t('common.loading')}</p></Show>
      <Show when={!props.available()}><p role="status">{t('library.unreachable')}</p></Show>
    </>}>{access => <SubsonicAccessView access={access()} password={state.password()} busy={state.busy() || state.loading()} unavailable={!props.available()}
      serverUrl={props.origin()} onGenerate={() => void state.generate()} onRevoke={() => void state.revoke()}
      onCopyServer={() => void state.copyServer()} onCopyPassword={() => void state.copyPassword()} />}</Show>
    <Show when={state.error()}><p role="alert">{state.error()} <button disabled={state.loading() || state.busy() || !props.available()} onClick={() => void state.load()}>{t('common.retry')}</button></p></Show>
    <Show when={state.copied()}><p role="status">{t('social.copied')}</p></Show>
  </section>;
}
