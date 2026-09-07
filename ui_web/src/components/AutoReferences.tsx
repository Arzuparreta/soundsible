import { createSignal, For, Show } from 'solid-js';
import { state, actions } from '../stores';
import { autoTrackDragging, readAutoTrackTransfer, writeAutoTrackTransfer } from '../lib/autoMusicTransfer';
import { openOverlay } from '../lib/overlay';
import { coverStyle } from '../lib/cover';
import { trackCoverUrl } from '../lib/media';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import styles from './AutoMode.module.css';

export function AutoReferences(props: { carried?: Track; onUse: (track: Track) => void; onAdd: () => void }) {
  const [over, setOver] = createSignal(false);
  const armed = () => Boolean(autoTrackDragging() || props.carried);
  let depth = 0;
  const rows = () => <For each={state.autoMode.sources}>{(source) => <div class={styles.referenceRow}
    draggable={source.tracks.length === 1} onDragStart={(event) => source.tracks[0] && writeAutoTrackTransfer(event, { track: source.tracks[0] })}>
    <span class={styles.referenceCover} style={coverStyle(source.label, source.tracks[0] ? trackCoverUrl(source.tracks[0], 'thumb') : undefined)} />
    <span class={styles.referenceName} title={source.label}>{source.label}</span><small>{source.tracks.length}</small>
    <button type="button" aria-label={t('autoMode.source.remove', { title: source.label })} onClick={() => actions.removeAutoSource(source.id)}>×</button>
  </div>}</For>;
  return <section class={styles.references} aria-label={t('musicExplorer.references')}
    data-target={armed() ? '' : undefined} data-over={over() ? '' : undefined}
    onDragEnter={(event) => { event.preventDefault(); depth += 1; setOver(true); }}
    onDragLeave={() => { depth = Math.max(0, depth - 1); if (!depth) setOver(false); }}
    onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; }}
    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); depth = 0; setOver(false); const transfer = readAutoTrackTransfer(event); if (transfer) props.onUse(transfer.track); }}>
    <header><strong>{t('musicExplorer.references')}</strong><button type="button" aria-label={t('musicExplorer.addReference')} onClick={() => props.carried ? props.onUse(props.carried) : props.onAdd()}>＋</button></header>
    <Show when={state.autoMode.sources.length} fallback={<button type="button" class={styles.referenceEmpty} onClick={props.onAdd}>{t('musicExplorer.referenceEmpty')}</button>}>
      <p>{t('musicExplorer.referenceHint')}</p>
      <div class={styles.referenceRows}>{rows()}</div>
      <Show when={state.autoMode.sources.length > 2}><button type="button" class={styles.referenceMore} onClick={() => openOverlay(() => <section class={styles.referenceSheet}><h2>{t('musicExplorer.references')}</h2>{rows()}</section>, { ariaLabel: () => t('musicExplorer.references') })}>{t('musicExplorer.viewReferences')} ({state.autoMode.sources.length})</button></Show>
    </Show>
  </section>;
}
