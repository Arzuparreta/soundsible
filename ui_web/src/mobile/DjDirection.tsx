import { createEffect, createSignal, Show } from 'solid-js';
import type { DjDirection } from '../lib/api';
import { openOverlay } from '../lib/overlay';
import { t } from '../lib/i18n';
import styles from '../components/MetadataEditor.module.css';

/** Edits future planning only; the native programme continues to own playback. */
export function openNativeDjDirection(initial: DjDirection | undefined, current: () => boolean,
  submit: (direction: DjDirection) => Promise<void>): void {
  if (!current()) return;
  openOverlay(close => {
    const [energy, setEnergy] = createSignal(initial?.energy ?? 0);
    const [familiarity, setFamiliarity] = createSignal(initial?.familiarity ?? 0);
    const [prompt, setPrompt] = createSignal(initial?.prompt ?? '');
    const [busy, setBusy] = createSignal(false);
    const [failed, setFailed] = createSignal(false);
    createEffect(() => { if (!current()) close(); });
    return <form class={styles.form} onSubmit={async event => {
      event.preventDefault();
      if (!current() || busy()) return;
      setBusy(true); setFailed(false);
      try {
        await submit({ energy: energy(), familiarity: familiarity(), prompt: prompt().trim(), include: [...(initial?.include ?? [])], exclude: [...(initial?.exclude ?? [])] });
        if (current()) close();
      } catch { if (current()) setFailed(true); }
      finally { setBusy(false); }
    }}>
      <h2>{t('autoMode.dj.direction')}</h2>
      <p>{t('autoMode.dj.directionHint')}</p>
      <label class={styles.field}>{t('autoMode.booth.energy')}
        <select value={energy()} disabled={busy()} onChange={event => setEnergy(Number(event.currentTarget.value))}>
          <option value="-1">{t('autoMode.booth.energyDown')}</option><option value="0">{t('autoMode.booth.hold')}</option><option value="1">{t('autoMode.booth.energyUp')}</option>
        </select>
      </label>
      <label class={styles.field}>{t('autoMode.booth.crate')}
        <select value={familiarity()} disabled={busy()} onChange={event => setFamiliarity(Number(event.currentTarget.value))}>
          <option value="-1">{t('autoMode.booth.crateDeep')}</option><option value="0">{t('autoMode.booth.hold')}</option><option value="1">{t('autoMode.booth.crateKnown')}</option>
        </select>
      </label>
      <label class={styles.field}>{t('autoMode.dj.tellDj')}<textarea maxLength={2000} value={prompt()} disabled={busy()} onInput={event => setPrompt(event.currentTarget.value)} /></label>
      <Show when={failed()}><p role="alert">{t('common.loadFailed')}</p></Show>
      <button type="submit" disabled={busy() || !current()}>{t('autoMode.dj.send')}</button>
    </form>;
  }, { ariaLabel: () => t('autoMode.dj.direction') });
}
