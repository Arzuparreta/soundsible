import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js';
import { SettingsGroup, SwitchRow } from '../components/SettingsRows';
import type { ProgramCommand, ProgramState } from '../lib/program/runtime';
import { t } from '../lib/i18n';

/** Service observations confirm the preference that changes the native PCM output. */
export default function NativeSettingsLeveling(props: { state: Pick<ProgramState, 'ready' | 'leveling' | 'mixing'> | null; pending: boolean; available: boolean;
  command: (command: ProgramCommand) => Promise<void>; preference?: 'leveling' | 'mixing' }) {
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal('');
  let disposed = false; onCleanup(() => { disposed = true; });
  const preference = () => props.preference ?? 'leveling';
  const observed = () => props.state?.[preference()];
  const known = () => observed()?.settingsPhase === 'ready' && typeof observed()?.enabled === 'boolean';
  const disabled = () => busy() || props.pending || !props.available || !props.state?.ready || observed()?.settingsPhase === 'loading';
  async function change(reload = false) {
    if (disposed || disabled() || !reload && !known()) return;
    setBusy(true); setError('');
    try { await props.command({ action: preference(), enabled: observed()?.enabled !== true, reload }); }
    catch { if (!disposed) setError(t('settings.toast.notSaved')); }
    finally { if (!disposed) setBusy(false); }
  }
  const connected = createMemo(() => props.available && props.state?.ready === true && !props.pending);
  createEffect(on(connected, ready => { if (ready && (!observed() || ['idle', 'cached'].includes(observed()?.settingsPhase ?? ''))) void change(true); }));
  return <section data-testid={`android-${preference()}-settings`} aria-busy={busy() || props.pending || observed()?.settingsPhase === 'loading'}>
    <Show when={known()} fallback={<Show when={props.available} fallback={<p role="status">{t('library.unreachable')}</p>}>
      <Show when={observed()?.settingsPhase === 'unavailable'} fallback={<p role="status">{t('common.loading')}</p>}>
        <p role="alert">{t('common.loadFailed')} <button disabled={disabled()} onClick={() => void change(true)}>{t('common.retry')}</button></p>
      </Show>
    </Show>}>
      <SettingsGroup><SwitchRow anchor={preference() === 'mixing' ? 'dj-mixing' : 'volume-leveling'} label={t(preference() === 'mixing' ? 'settings.djMixing' : 'settings.volumeLeveling')} hint={t(preference() === 'mixing' ? 'settings.note.djMixing' : 'settings.note.volumeLeveling')}
        checked={observed()!.enabled === true} disabled={disabled()} onChange={() => void change()} /></SettingsGroup>
    </Show>
    <Show when={error()}><p role="alert">{error()} <button disabled={disabled()} onClick={() => void change(true)}>{t('common.retry')}</button></p></Show>
  </section>;
}
