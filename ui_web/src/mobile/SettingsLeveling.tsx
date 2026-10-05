import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js';
import { SettingsGroup, SwitchRow } from '../components/SettingsRows';
import type { ProgramCommand, ProgramState } from '../lib/program/runtime';
import { t } from '../lib/i18n';

/** Service observations confirm the preference that changes the native PCM output. */
export default function NativeSettingsLeveling(props: { state: Pick<ProgramState, 'ready' | 'leveling'> | null; pending: boolean; available: boolean;
  command: (command: ProgramCommand) => Promise<void> }) {
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal('');
  let disposed = false; onCleanup(() => { disposed = true; });
  const known = () => props.state?.leveling?.settingsPhase === 'ready' && typeof props.state.leveling.enabled === 'boolean';
  const disabled = () => busy() || props.pending || !props.available || !props.state?.ready || props.state.leveling?.settingsPhase === 'loading';
  async function change(reload = false) {
    if (disposed || disabled() || !reload && !known()) return;
    setBusy(true); setError('');
    try { await props.command({ action: 'leveling', enabled: props.state?.leveling?.enabled !== true, reload }); }
    catch { if (!disposed) setError(t('settings.toast.notSaved')); }
    finally { if (!disposed) setBusy(false); }
  }
  const connected = createMemo(() => props.available && props.state?.ready === true && !props.pending);
  createEffect(on(connected, ready => { if (ready && (!props.state?.leveling || ['idle', 'cached'].includes(props.state.leveling.settingsPhase))) void change(true); }));
  return <section data-testid="android-leveling-settings" aria-busy={busy() || props.pending || props.state?.leveling?.settingsPhase === 'loading'}>
    <Show when={known()} fallback={<Show when={props.available} fallback={<p role="status">{t('library.unreachable')}</p>}>
      <Show when={props.state?.leveling?.settingsPhase === 'unavailable'} fallback={<p role="status">{t('common.loading')}</p>}>
        <p role="alert">{t('common.loadFailed')} <button disabled={disabled()} onClick={() => void change(true)}>{t('common.retry')}</button></p>
      </Show>
    </Show>}>
      <SettingsGroup><SwitchRow anchor="volume-leveling" label={t('settings.volumeLeveling')} hint={t('settings.note.volumeLeveling')}
        checked={props.state!.leveling!.enabled === true} disabled={disabled()} onChange={() => void change()} /></SettingsGroup>
    </Show>
    <Show when={error()}><p role="alert">{error()} <button disabled={disabled()} onClick={() => void change(true)}>{t('common.retry')}</button></p></Show>
  </section>;
}
