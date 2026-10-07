import { createEffect, createSignal, on, Show } from 'solid-js';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import type { createIncomingTrack } from './incoming';
import styles from './AndroidStart.module.css';

/** Arrival never replaces audio; an explicit action is required on the active account. */
export default function IncomingSong(props: { incoming: ReturnType<typeof createIncomingTrack>; track: () => Track | null;
  disabled: boolean; onPlay: (track: Track) => Promise<void>; onMenu: (track: Track, event?: MouseEvent) => void }) {
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  createEffect(on(() => props.incoming.selection()?.token, () => setFailed(false)));
  return <Show when={props.incoming.selection()}>{selected => <section class={styles.library} data-testid="android-shared-song" aria-label={t('search.sharedLink')}>
    <p>{selected().capsule.title}<br /><small>{selected().capsule.artist}</small></p>
    <button data-shared-play disabled={props.disabled || busy()} onClick={async () => {
      const captured = selected(); const track = props.track();
      if (props.disabled || busy() || !track) return;
      setBusy(true); setFailed(false);
      try { await props.onPlay(track); await props.incoming.dismiss(captured.token); }
      catch { if (props.incoming.selection()?.token === captured.token) setFailed(true); }
      finally { setBusy(false); }
    }}>{t('common.play')}</button>
    <button data-shared-menu aria-label={t('songRow.ariaMore')} disabled={props.disabled || busy()} onClick={event => {
      const track = props.track(); if (!props.disabled && !busy() && track) props.onMenu(track, event);
    }}>⋯</button>
    <button data-shared-dismiss disabled={busy()} onClick={() => void props.incoming.dismiss(selected().token).catch(() => setFailed(true))}>{t('common.close')}</button>
    <Show when={failed()}><p role="alert">{t('common.loadFailed')}</p></Show>
  </section>}</Show>;
}
