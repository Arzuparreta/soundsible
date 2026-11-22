import type { MenuEvent } from '../lib/menuEvent';
import { createMemo, createSignal, Show } from 'solid-js';
import { CollectionRows } from './CollectionView';
import { MusicListRowView } from './MusicListRowView';
import { programCover } from '../lib/program/tracks';
import { t } from '../lib/i18n';
import type { MenuAction } from './ActionMenu';
import { offers, type ProgramCommand, type ProgramOccurrence, type ProgramState } from '../lib/program/runtime';
import styles from './ProgramQueue.module.css';

/** Observe the service queue; never regenerate its sources from library rows. */
export default function ProgramQueue(props: { state: ProgramState; pending: boolean; command(command: ProgramCommand): Promise<void>; onMenu?: (entry: ProgramOccurrence, event: MenuEvent | undefined, actions: MenuAction[]) => void }) {
  const [editing, setEditing] = createSignal(false);
  const [scroll, setScroll] = createSignal<HTMLDivElement | null>(null);
  const [focusedKey, setFocusedKey] = createSignal<string>();
  const run = (command: ProgramCommand) => { void props.command(command).catch(() => {}); };
  const disabled = () => props.pending || !props.state.ready;
  /** Upcoming songs the listener asked for, as the web's manual lane; the DJ route has none. */
  const requests = createMemo(() => props.state.dj?.active ? 0 : props.state.items.filter((entry, index) => index > props.state.index && entry.lane === 'manual').length);
  /** The first upcoming song of what was playing, once requests sit before it: where the web's "Then" section starts. */
  const continuation = createMemo(() => {
    const index = props.state.items.findIndex((entry, at) => at > props.state.index && entry.lane === 'context');
    return index > props.state.index + 1 && props.state.items.slice(props.state.index + 1, index).some(entry => entry.lane === 'manual') ? index : -1;
  });
  return <section class={styles.queue} data-testid="program-queue" aria-label={t('nowPlaying.manualQueue')} aria-busy={props.pending} onFocusIn={event => {
    const row = (event.target as Element).closest<HTMLElement>('[data-queue-key]');
    if (row) setFocusedKey(row.dataset.queueKey);
  }}>
    <header><h2>{t('nowPlaying.manualQueue')} · {props.state.items.length}</h2><Show when={requests() > 0 && offers(props.state, 'queueEdit')}><button type="button" data-queue-clear-requests disabled={disabled()}
      onClick={() => run({ action: 'clearManual', queueToken: props.state.queueToken })}>{t('nowPlaying.clearManualQueue')}</button></Show>
      <Show when={offers(props.state, 'queueEdit')}><button type="button" aria-pressed={editing()} onClick={() => setEditing(value => !value)}>{editing() ? t('musicList.done') : t('musicExplorer.edit')}</button></Show></header>
    <div ref={setScroll} class={styles.scroll}>
      <CollectionRows items={props.state.items} scrollElement={scroll} itemKey={entry => entry.key} measureRows
        keepMountedIndex={editing() ? props.state.items.findIndex(entry => entry.key === focusedKey()) : -1}>
        {(occurrence, index) => {
          const row = () => ({ entry: occurrence(), index: index() });
          const key = () => occurrence().key;
          const target = () => ({ index: index(), key: key(), queueToken: props.state.queueToken });
          const protectedRow = (index: number) => props.state.dj?.active === true && (props.state.dj.protectedKeys?.includes(props.state.items[index]?.key) === true || index >= props.state.index && index < (props.state.dj.editableFrom ?? props.state.index + 1));
          const moveTarget = (delta: -1 | 1) => {
            if (!props.state.dj?.active) return row().index + delta;
            const owner = row().entry.routeOwnerKey ?? key();
            const group = props.state.items.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.key === owner || entry.routeOwnerKey === owner);
            return delta < 0 ? group[0].index - 1 : group.at(-1)!.index + 1;
          };
          const canMove = (target: number) => !protectedRow(row().index) && !protectedRow(target);
          return <div class={styles.row} data-queue-key={key()}>
            <MusicListRowView title={row().entry.title || row().entry.id} subtitle={row().entry.artist} annotation={protectedRow(row().index) && row().index > props.state.index ? t('autoMode.dj.cued') : row().entry.generated ? t(row().entry.generatedSource === 'autoplay' ? 'nowPlaying.autoplayQueue' : 'nowPlaying.radioQueue') : row().index === continuation() ? t('nowPlaying.continuationSection') : undefined} seed={row().entry.id} cover={programCover(row().entry)} actionLabel={`${row().index + 1} · ${row().entry.title || row().entry.id} — ${row().entry.artist}`} index={row().index + 1} playback active={props.state.index === row().index}
              disabled={disabled()} playbackTrack={props.state.items[props.state.index]?.key} onActivate={() => run({ action: 'select', ...target() })} onMenu={props.onMenu ? event => {
                const captured = { ...target(), generation: props.state.generation, programToken: props.state.programToken };
                props.onMenu?.(row().entry, event, !offers(props.state, 'queueEdit') ? [] : [{ label: t('nowPlaying.removeFromQueue'), danger: true,
                  disabled: disabled() || protectedRow(row().index), onSelect: () => {
                    if (disabled() || props.state.generation !== captured.generation || props.state.programToken !== captured.programToken ||
                      props.state.queueToken !== captured.queueToken || props.state.items[captured.index]?.key !== captured.key || protectedRow(captured.index)) return;
                    run({ action: 'remove', index: captured.index, key: captured.key, queueToken: captured.queueToken });
                  } }]);
              } : undefined} />
              <Show when={editing() && offers(props.state, 'queueEdit')}><div class={styles.edit}>
                <button type="button" data-queue-action="up" aria-label={`${t('musicList.moveUp')}: ${row().index + 1} · ${row().entry.title}`} disabled={disabled() || moveTarget(-1) < 0 || !canMove(moveTarget(-1))} onClick={() => run({ action: 'move', ...target(), toIndex: moveTarget(-1) })}>↑</button>
                <button type="button" data-queue-action="down" aria-label={`${t('musicList.moveDown')}: ${row().index + 1} · ${row().entry.title}`} disabled={disabled() || moveTarget(1) >= props.state.items.length || !canMove(moveTarget(1))} onClick={() => run({ action: 'move', ...target(), toIndex: moveTarget(1) })}>↓</button>
                <button type="button" data-queue-action="remove" aria-label={`${t('nowPlaying.removeFromQueue')}: ${row().index + 1} · ${row().entry.title}`} disabled={disabled() || protectedRow(row().index)} onClick={() => run({ action: 'remove', ...target() })}>×</button>
              </div></Show>
          </div>;
        }}
      </CollectionRows>
    </div>
  </section>;
}
