import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { coverStyle } from '../lib/cover';
import { programCover } from '../lib/program/tracks';
import { clockTime } from '../lib/format';
import { t } from '../lib/i18n';
import type { ProgramState, ProgramCommand } from '../lib/program/runtime';
import styles from './ProgramTransport.module.css';

/** Stateless ownership: presentation observes a program; commands never create audio here. */
export default function ProgramTransport(props: { state: ProgramState; pending: boolean; command(command: ProgramCommand): Promise<void> }) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 500); onCleanup(() => clearInterval(timer));
  const retryBlocked = () => (props.state.preview?.retryNotBeforeMs ?? 0) > now();
  const [seeking, setSeeking] = createSignal<number | null>(null);
  const occurrence = createMemo(() => `${props.state.generation}:${props.state.items[props.state.index]?.key ?? ""}`);
  createEffect(() => { occurrence(); setSeeking(null); });
  const run = (command: ProgramCommand) => props.command(command).catch(() => {});
  const disabled = () => !props.state.ready || props.pending;
  return <section class={styles.program} data-testid="android-program" aria-label={t('nowPlaying.nowPlayingSection')} aria-busy={props.pending}>
    <div class={styles.heading}><span class={styles.artwork} data-program-artwork aria-hidden="true" style={coverStyle(props.state.id, programCover(props.state.items[props.state.index]))} />
    <p>{props.state.title || props.state.id}<br /><small>{props.state.artist}</small></p>
    <button data-program-close aria-label={t('android.closeProgram')} title={t('android.closeProgram')} disabled={disabled()} onClick={() => void run({ action: 'stop', queueToken: props.state.queueToken })}>×</button></div>
    <Show when={props.state.items[props.state.index]?.mediaKind === 'podcast_episode'}><button data-podcast-back aria-label={t('podcasts.skipBack')} disabled={disabled() || props.state.seekable === false} onClick={() => void run({ action: 'skip', seconds: -15, index: props.state.index, key: props.state.items[props.state.index]?.key ?? '', queueToken: props.state.queueToken })}>−15s</button><button data-podcast-forward aria-label={t('podcasts.skipForward')} disabled={disabled() || props.state.seekable === false} onClick={() => void run({ action: 'skip', seconds: 15, index: props.state.index, key: props.state.items[props.state.index]?.key ?? '', queueToken: props.state.queueToken })}>+15s</button></Show>
    <button disabled={disabled() || !props.state.hasPrevious} onClick={() => void run({ action: 'previous' })}>{t('common.prev')}</button>
    <button disabled={disabled()} onClick={() => void run({ action: props.state.playWhenReady ? 'pause' : 'play' })}>{props.state.playWhenReady ? t('common.pause') : t('common.play')}</button>
    <button disabled={disabled() || !props.state.hasNext} onClick={() => void run({ action: 'next' })}>{t('common.next')}</button>
    <button disabled={disabled()} aria-pressed={props.state.shuffle} onClick={() => void run({ action: 'shuffle', enabled: !props.state.shuffle })}>{t('nowPlaying.shuffle')}</button>
    <label>{t('nowPlaying.repeat')} <select aria-label={t('nowPlaying.repeat')} value={props.state.repeat} disabled={disabled()} onChange={event => void run({ action: 'repeat', mode: Number(event.currentTarget.value) as 0 | 1 | 2 })}>
      <option value="0">{t('android.repeatOff')}</option><option value="1">{t('android.repeatOne')}</option><option value="2">{t('android.repeatAll')}</option>
    </select></label>
    <input aria-label={t('android.seek')} disabled={disabled() || props.state.durationMs <= 0 || props.state.seekable === false} type="range" min="0" max={props.state.durationMs || 0} value={seeking() ?? props.state.positionMs} step="1000" aria-valuetext={clockTime((seeking() ?? props.state.positionMs) / 1000)} onInput={event => setSeeking(Number(event.currentTarget.value))} onChange={event => { const target = Number(event.currentTarget.value); void run({ action: 'seek', positionMs: target }).finally(() => setSeeking(null)); }} />
    <small>{clockTime(props.state.positionMs / 1000)} / {clockTime(props.state.durationMs / 1000)}</small>
    <Show when={!props.state.error && props.state.state === 2}><p role="status">{t('common.loading')}</p></Show>
    <Show when={props.state.preview?.retryPending}><p role="status">{t('android.previewRetry')}</p></Show>
    <Show when={props.state.preview?.preparation?.progress !== undefined}><progress aria-label={t('android.previewPreparing')} max="1" value={props.state.preview?.preparation?.progress} /></Show>
    <Show when={props.state.error}><p role="alert">{t(props.state.errorKind === 'permission' || props.state.errorStatus === 403 ? 'android.permissionDenied' : props.state.errorKind === 'connection' || props.state.errorKind === 'server' ? 'android.playbackInterrupted' : 'common.loadFailed')}</p><Show when={props.state.errorKind === 'connection' || props.state.errorKind === 'server'}><button data-program-retry disabled={disabled() || retryBlocked()} onClick={() => void run({ action: 'retry', index: props.state.index, key: props.state.items[props.state.index]?.key ?? '', queueToken: props.state.queueToken })}>{t('common.retry')}</button></Show></Show>
  </section>;
}
