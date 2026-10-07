import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import { t } from '../lib/i18n';
import type { ProgramCommand, ProgramState } from '../lib/program/runtime';
import styles from '../components/MetadataEditor.module.css';

/** Source edits change future planning; listener requests remain owned by the service. */
export function openNativeDjSources(state: () => ProgramState, pending: () => boolean,
  execute: (command: ProgramCommand) => Promise<void>): void {
  const captured = state();
  if (!captured.ready || !captured.dj?.active || !captured.programToken || pending()) return;
  openOverlay(close => {
    const [busy, setBusy] = createSignal(false);
    const [failed, setFailed] = createSignal(false);
    let disposed = false;
    onCleanup(() => { disposed = true; });
    const current = () => !disposed && state().generation === captured.generation &&
      state().programToken === captured.programToken && state().dj?.active === true;
    createEffect(() => { if (!current()) close(); });
    const sources = () => state().dj?.sources ?? [];
    async function remove(id: string) {
      if (!current() || !state().ready || busy() || pending() || sources().length <= 1 || !sources().some(source => source.id === id)) return;
      const remaining = sources().filter(source => source.id !== id);
      setBusy(true); setFailed(false);
      try {
        await execute({ action: 'djSettings', programToken: captured.programToken!, sources: remaining });
      } catch { if (current()) setFailed(true); }
      finally { if (current()) setBusy(false); }
    }
    return <section class={styles.form} data-testid="android-dj-sources" aria-busy={busy()}>
      <h2>{t('autoMode.source.title')}</h2>
      <For each={sources()}>{source => <div>
        <span>{source.label}</span>
        <button type="button" aria-label={t('autoMode.source.remove', { title: source.label })}
          data-source-id={source.id} disabled={busy() || pending() || !current() || sources().length <= 1}
          onClick={() => void remove(source.id)}>×</button>
      </div>}</For>
      <Show when={failed()}><p role="alert">{t('common.loadFailed')}</p></Show>
    </section>;
  }, { ariaLabel: () => t('autoMode.source.title') });
}
