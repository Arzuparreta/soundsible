import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { MusicListRowView } from './MusicListRowView';
import { programCover } from '../lib/program/tracks';
import { t } from '../lib/i18n';
import type { MenuAction } from './ActionMenu';
import type { ProgramCommand, ProgramOccurrence, ProgramState } from '../lib/program/runtime';
import styles from './ProgramQueue.module.css';

/** Observe the service queue; never regenerate its sources from library rows. */
export default function ProgramQueue(props: { state: ProgramState; pending: boolean; command(command: ProgramCommand): Promise<void>; onMenu?: (entry: ProgramOccurrence, event: MouseEvent | undefined, actions: MenuAction[]) => void }) {
  const [editing, setEditing] = createSignal(false);
  const [height, setHeight] = createSignal(56);
  let scroll!: HTMLDivElement;
  // Primitive occurrence keys retain rows/focus across ticks and positional changes.
  const entries = createMemo(() => new Map(props.state.items.map((entry, index) => [entry.key, { entry, index }])));
  const keys = createMemo<string[]>(before => {
    const after = props.state.items.map(entry => entry.key);
    if (scroll && (before.length !== after.length || before.some((key, index) => key !== after[index]))) {
      const focused = document.activeElement as HTMLElement | null;
      // Moving a DOM node can blur it even when Solid preserves its identity.
      if (focused && scroll.contains(focused)) queueMicrotask(() => {
        if (focused.isConnected && document.activeElement === document.body) focused.focus({ preventScroll: true });
      });
    }
    return after;
  }, [], { equals: (before, after) => before.length === after.length && before.every((key, index) => key === after[index]) });
  const itemKey = createMemo(() => { const current = keys(); return (index: number) => current[index]; });
  const rows = createVirtualizer({
    get count() { return keys().length; },
    getScrollElement: () => scroll,
    get getItemKey() { return itemKey(); },
    estimateSize: () => height(), overscan: 5,
  });
  const positions = createMemo(() => new Map(rows.getVirtualItems().map(item => [String(item.key), item.start])));
  const run = (command: ProgramCommand) => { void props.command(command).catch(() => {}); };
  const disabled = () => props.pending || !props.state.ready;
  /** Upcoming songs the listener asked for, as the web's manual lane; the DJ route has none. */
  const requests = createMemo(() => props.state.dj?.active ? 0 : props.state.items.filter((entry, index) => index > props.state.index && entry.lane === 'manual').length);
  /** The first upcoming song of what was playing, once requests sit before it: where the web's "Then" section starts. */
  const continuation = createMemo(() => {
    const index = props.state.items.findIndex((entry, at) => at > props.state.index && entry.lane === 'context');
    return index > props.state.index + 1 && props.state.items.slice(props.state.index + 1, index).some(entry => entry.lane === 'manual') ? index : -1;
  });
  onMount(() => {
    const measure = () => { setHeight(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 56); rows.measure(); };
    const observer = new ResizeObserver(measure); observer.observe(scroll); measure(); onCleanup(() => observer.disconnect());
  });
  return <section class={styles.queue} data-testid="program-queue" aria-label={t('nowPlaying.manualQueue')} aria-busy={props.pending}>
    <header><h2>{t('nowPlaying.manualQueue')} · {props.state.items.length}</h2><Show when={requests() > 0}><button type="button" data-queue-clear-requests disabled={disabled()}
      onClick={() => run({ action: 'clearManual', queueToken: props.state.queueToken })}>{t('nowPlaying.clearManualQueue')}</button></Show>
      <button type="button" aria-pressed={editing()} onClick={() => setEditing(value => !value)}>{editing() ? t('musicList.done') : t('musicExplorer.edit')}</button></header>
    <div ref={scroll} class={styles.scroll}>
      <div style={{ height: `${rows.getTotalSize()}px`, position: 'relative' }}>
        <For each={[...positions().keys()]}>{key => {
          const row = () => entries().get(key)!;
          const target = () => ({ index: row().index, key, queueToken: props.state.queueToken });
          const protectedRow = (index: number) => props.state.dj?.active === true && (props.state.dj.protectedKeys?.includes(props.state.items[index]?.key) === true || index >= props.state.index && index < (props.state.dj.editableFrom ?? props.state.index + 1));
          const moveTarget = (delta: -1 | 1) => {
            if (!props.state.dj?.active) return row().index + delta;
            const owner = row().entry.routeOwnerKey ?? key;
            const group = props.state.items.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.key === owner || entry.routeOwnerKey === owner);
            return delta < 0 ? group[0].index - 1 : group.at(-1)!.index + 1;
          };
          const canMove = (target: number) => !protectedRow(row().index) && !protectedRow(target);
          return <Show when={entries().has(key)}><div class={styles.row} data-queue-key={key} data-index={row().index} ref={element => queueMicrotask(() => { if (element.isConnected) rows.measureElement(element); })} style={{ transform: `translateY(${positions().get(key) ?? 0}px)` }}>
            <MusicListRowView title={row().entry.title || row().entry.id} subtitle={row().entry.artist} annotation={protectedRow(row().index) && row().index > props.state.index ? t('autoMode.dj.cued') : row().entry.generated ? t(row().entry.generatedSource === 'autoplay' ? 'nowPlaying.autoplayQueue' : 'nowPlaying.radioQueue') : row().index === continuation() ? t('nowPlaying.continuationSection') : undefined} seed={row().entry.id} cover={programCover(row().entry)} actionLabel={`${row().index + 1} · ${row().entry.title || row().entry.id} — ${row().entry.artist}`} index={row().index + 1} playback active={props.state.index === row().index}
              disabled={disabled()} playbackTrack={props.state.items[props.state.index]?.key} onActivate={() => run({ action: 'select', ...target() })} onMenu={props.onMenu ? event => {
                const captured = { ...target(), generation: props.state.generation, programToken: props.state.programToken };
                props.onMenu?.(row().entry, event, [{ label: t('nowPlaying.removeFromQueue'), danger: true,
                  disabled: disabled() || protectedRow(row().index), onSelect: () => {
                    if (disabled() || props.state.generation !== captured.generation || props.state.programToken !== captured.programToken ||
                      props.state.queueToken !== captured.queueToken || props.state.items[captured.index]?.key !== key || protectedRow(captured.index)) return;
                    run({ action: 'remove', index: captured.index, key, queueToken: captured.queueToken });
                  } }]);
              } : undefined} />
              <Show when={editing()}><div class={styles.edit}>
                <button type="button" data-queue-action="up" aria-label={`${t('musicList.moveUp')}: ${row().index + 1} · ${row().entry.title}`} disabled={disabled() || moveTarget(-1) < 0 || !canMove(moveTarget(-1))} onClick={() => run({ action: 'move', ...target(), toIndex: moveTarget(-1) })}>↑</button>
                <button type="button" data-queue-action="down" aria-label={`${t('musicList.moveDown')}: ${row().index + 1} · ${row().entry.title}`} disabled={disabled() || moveTarget(1) >= props.state.items.length || !canMove(moveTarget(1))} onClick={() => run({ action: 'move', ...target(), toIndex: moveTarget(1) })}>↓</button>
                <button type="button" data-queue-action="remove" aria-label={`${t('nowPlaying.removeFromQueue')}: ${row().index + 1} · ${row().entry.title}`} disabled={disabled() || protectedRow(row().index)} onClick={() => run({ action: 'remove', ...target() })}>×</button>
              </div></Show>
          </div></Show>;
        }}</For>
      </div>
    </div>
  </section>;
}
