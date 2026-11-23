import { createSignal, For, Show } from 'solid-js';
import { player } from '../stores/player';
import { autoTrackDragging, readAutoTrackTransfer, writeAutoTrackTransfer } from '../lib/autoMusicTransfer';
import { openContextMenu } from '../lib/contextMenu';
import { openOverlay } from '../lib/overlay';
import { coverStyle } from '../lib/cover';
import { trackCoverUrl } from '../lib/media';
import { t } from '../lib/i18n';
import { isPodcastTrack } from '../lib/track';
import { Control } from '../design/Control';
import type { Track } from '../types/music';
import { ChevronDownIcon, CloseIcon, menuIcons, PlusIcon } from './icons';
import styles from './AutoMode.module.css';

export function AutoReferences(props: { carried?: Track; onUse: (track: Track) => void; onAdd: () => void; onChange: () => void }) {
  const [over, setOver] = createSignal(false);
  const armed = () => Boolean(autoTrackDragging() || props.carried);
  let depth = 0;
  const canStartFromCurrent = () => {
    const track = player().playback.currentTrack;
    return Boolean(track && !isPodcastTrack(track));
  };
  const openChangeMenu = (event: MouseEvent) => {
    openContextMenu({
      title: t('musicExplorer.references'),
      actions: [
        {
          icon: menuIcons.changeSession(),
          label: t('musicExplorer.chooseOtherMusic'),
          onSelect: () => props.onChange(),
        },
        {
          icon: menuIcons.source(),
          label: t('musicExplorer.startDjFromCurrent'),
          disabled: !canStartFromCurrent(),
          onSelect: () => {
            const track = player().playback.currentTrack;
            if (track) void player().actions.startDjFromTrack(track);
          },
        },
      ],
    }, event);
  };
  const rows = () => <For each={player().autoMode.sources}>{(source) => <div class={styles.referenceRow}
    draggable={source.tracks.length === 1} onDragStart={(event) => source.tracks[0] && writeAutoTrackTransfer(event, { track: source.tracks[0] })}>
    <span class={styles.referenceCover} style={coverStyle(source.label, source.tracks[0] ? trackCoverUrl(source.tracks[0], 'thumb') : undefined)} />
    <span class={styles.referenceName} title={source.label}>{source.label}</span><small>{source.tracks.length}</small>
    <Show when={player().autoMode.sources.length > 1}>
      <Control class={styles.referenceRemove} aria-label={t('autoMode.source.remove', { title: source.label })} onClick={() => player().actions.removeAutoSource(source.id)}>
        <CloseIcon size={14} />
      </Control>
    </Show>
  </div>}</For>;
  return <section class={styles.references} aria-label={t('musicExplorer.references')}
    data-target={armed() ? '' : undefined} data-over={over() ? '' : undefined}
    onDragEnter={(event) => { event.preventDefault(); depth += 1; setOver(true); }}
    onDragLeave={() => { depth = Math.max(0, depth - 1); if (!depth) setOver(false); }}
    onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; }}
    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); depth = 0; setOver(false); const transfer = readAutoTrackTransfer(event); if (transfer) props.onUse(transfer.track); }}>
    <header class={styles.sessionActions}>
      <span class={styles.referencesHeading}>{t('autoMode.source.title')}</span>
      <span class={styles.referencesButtons}>
        <Control
          class={`${styles.refAction} ${styles.refActionPrimary}`}
          title={t('musicExplorer.mixWith')}
          onClick={() => props.carried ? props.onUse(props.carried) : props.onAdd()}
        >
          <PlusIcon size={14} />
          <span>{t('musicExplorer.mixWith')}</span>
        </Control>
        <Control
          class={styles.refAction}
          aria-haspopup="menu"
          title={t('musicExplorer.changeSession')}
          onClick={openChangeMenu}
        >
          <span>{t('musicExplorer.changeSession')}</span>
          <ChevronDownIcon size={13} />
        </Control>
      </span>
    </header>
    <Show when={player().autoMode.sources.length} fallback={<Control class={styles.referenceEmpty} onClick={props.onAdd}>{t('musicExplorer.referenceEmpty')}</Control>}>
      <div class={styles.referenceRows}>{rows()}</div>
      <Show when={player().autoMode.sources.length > 2}><Control class={styles.referenceMore} onClick={() => openOverlay(() => <section class={styles.referenceSheet}><h2>{t('musicExplorer.references')}</h2>{rows()}</section>, { ariaLabel: () => t('musicExplorer.references') })}>{t('musicExplorer.viewReferences')} ({player().autoMode.sources.length})</Control></Show>
    </Show>
  </section>;
}
