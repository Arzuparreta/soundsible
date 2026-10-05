import { createSignal, onCleanup, Show } from 'solid-js';
import { AutoplaySettingsView } from '../components/AutoplaySettingsView';
import type { ProgramCommand, ProgramState } from '../lib/program/runtime';
import { t } from '../lib/i18n';

/** The existing service confirms preference and updates the actual native runway. */
export default function NativeSettingsPlayback(props: { state: Pick<ProgramState, 'ready' | 'autoplay'> | null; pending: boolean; available: boolean;
  command: (command: ProgramCommand) => Promise<void> }) {
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal('');
  let disposed = false; onCleanup(() => { disposed = true; });
  const known = () => props.state?.autoplay?.settingsPhase === 'ready' && typeof props.state.autoplay.enabled === 'boolean';
  const disabled = () => busy() || props.pending || !props.available || !props.state?.ready || props.state.autoplay?.settingsPhase === 'loading';
  async function change(reload = false) {
    if (disposed || disabled() || !reload && !known()) return;
    setBusy(true); setError('');
    try { await props.command({ action: 'autoplay', enabled: props.state?.autoplay?.enabled !== true, reload }); }
    catch { if (!disposed) setError(t('settings.toast.notSaved')); }
    finally { if (!disposed) setBusy(false); }
  }
  return <section data-testid="android-playback-settings" aria-busy={busy() || props.pending || props.state?.autoplay?.settingsPhase === 'loading'}>
    <Show when={known()} fallback={<Show when={props.available} fallback={<p role="status">{t('library.unreachable')}</p>}>
      <Show when={props.state?.autoplay?.settingsPhase === 'unavailable'} fallback={<p role="status">{t('common.loading')}</p>}>
        <p role="alert">{t('common.loadFailed')} <button disabled={disabled()} onClick={() => void change(true)}>{t('common.retry')}</button></p>
      </Show>
    </Show>}>
      <AutoplaySettingsView enabled={props.state!.autoplay!.enabled === true} disabled={disabled()} onChange={() => void change()} />
    </Show>
    <Show when={error()}><p role="alert">{error()} <button disabled={disabled()} onClick={() => void change(true)}>{t('common.retry')}</button></p></Show>
  </section>;
}
