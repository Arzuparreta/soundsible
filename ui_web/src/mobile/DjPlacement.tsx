import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import { t } from '../lib/i18n';
import type { ProgramCommand, ProgramState, ProgramTrack } from '../lib/program/runtime';
import styles from '../components/MetadataEditor.module.css';

/** Choose a destination occurrence; the service and Core still own placement and audio. */
export function openNativeDjPlacement(track: ProgramTrack, state: () => ProgramState | null,
  pending: () => boolean, execute: (command: ProgramCommand) => Promise<void>): void {
  const captured = state();
  if (!captured?.ready || !captured.dj?.active || !captured.programToken || track.mediaKind === 'podcast_episode' || pending()) return;
  openOverlay(close => {
    const [beforeKey, setBeforeKey] = createSignal('');
    const [busy, setBusy] = createSignal(false);
    const [failed, setFailed] = createSignal(false);
    let disposed = false;
    onCleanup(() => { disposed = true; });
    const current = () => !disposed && state()?.generation === captured.generation &&
      state()?.programToken === captured.programToken && state()?.dj?.active === true;
    createEffect(() => { if (!current()) close(); });
    const targets = createMemo(() => {
      const observed = state();
      if (!observed?.dj?.active) return [];
      return observed.items.slice(Math.max(observed.index + 1, observed.dj.editableFrom ?? observed.index + 1))
        .filter(item => !item.routeOwnerKey && !observed.dj?.protectedKeys?.includes(item.key));
    });
    const validTarget = () => !beforeKey() || targets().some(item => item.key === beforeKey());
    const disabled = () => !current() || !state()?.ready || pending() || busy() || !validTarget() || (state()?.items.length ?? 1000) >= 1000;
    return <form class={styles.form} data-testid="android-dj-placement" onSubmit={async event => {
      event.preventDefault();
      if (disabled()) return;
      const observed = state()!;
      setBusy(true); setFailed(false);
      try {
        await execute({ action: 'djRequest', programToken: captured.programToken!, queueToken: observed.queueToken,
          tracks: [track], ...(beforeKey() ? { beforeKey: beforeKey() } : {}) });
        if (current()) close();
      } catch { if (current()) setFailed(true); }
      finally { if (current()) setBusy(false); }
    }}>
      <h2>{t('autoMode.route.addToRoute', { title: track.title })}</h2>
      <label class={styles.field}>{t('autoMode.panel.route')}
        <select value={beforeKey()} disabled={busy() || pending() || !current()} onChange={event => setBeforeKey(event.currentTarget.value)}>
          <option value="">{t('autoMode.route.djPlacement')}</option>
          <For each={targets()}>{item => <option value={item.key}>{t('autoMode.route.insertBefore', { title: item.title })}</option>}</For>
        </select>
      </label>
      <Show when={failed() || !validTarget()}><p role="alert">{t('common.loadFailed')}</p></Show>
      <button type="submit" disabled={disabled()}>{t('autoMode.route.add')}</button>
    </form>;
  }, { ariaLabel: () => t('autoMode.route.addToRoute', { title: track.title }) });
}
