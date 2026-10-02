import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { MusicListRowView } from './MusicListRowView';
import { t } from '../lib/i18n';
import type { ProgramCommand, ProgramState } from '../lib/program/runtime';
import styles from './ProgramQueue.module.css';

/** Observe the service queue; never regenerate its sources from library rows. */
export default function ProgramQueue(props: { state: ProgramState; pending: boolean; command(command: ProgramCommand): Promise<void> }) {
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
  onMount(() => {
    const measure = () => { setHeight(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 56); rows.measure(); };
    const observer = new ResizeObserver(measure); observer.observe(scroll); measure(); onCleanup(() => observer.disconnect());
  });
  return <section class={styles.queue} data-testid="program-queue" aria-label={t('nowPlaying.manualQueue')} aria-busy={props.pending}>
    <header><h2>{t('nowPlaying.manualQueue')} · {props.state.items.length}</h2><button type="button" aria-pressed={editing()} onClick={() => setEditing(value => !value)}>{editing() ? t('musicList.done') : t('musicExplorer.edit')}</button></header>
    <div ref={scroll} class={styles.scroll}>
      <div style={{ height: `${rows.getTotalSize()}px`, position: 'relative' }}>
        <For each={[...positions().keys()]}>{key => {
          const row = () => entries().get(key)!;
          const target = () => ({ index: row().index, key, queueToken: props.state.queueToken });
          return <Show when={entries().has(key)}><div class={styles.row} data-queue-key={key} data-index={row().index} ref={element => queueMicrotask(() => { if (element.isConnected) rows.measureElement(element); })} style={{ transform: `translateY(${positions().get(key) ?? 0}px)` }}>
            <MusicListRowView title={row().entry.title || row().entry.id} subtitle={row().entry.artist} seed={row().entry.id} actionLabel={`${row().index + 1} · ${row().entry.title || row().entry.id} — ${row().entry.artist}`} index={row().index + 1} playback active={props.state.index === row().index}
              disabled={disabled()} playbackTrack={props.state.items[props.state.index]?.key} onActivate={() => run({ action: 'select', ...target() })} />
              <Show when={editing()}><div class={styles.edit}>
                <button type="button" data-queue-action="up" aria-label={`${t('musicList.moveUp')}: ${row().index + 1} · ${row().entry.title}`} disabled={disabled() || row().index === 0} onClick={() => run({ action: 'move', ...target(), toIndex: row().index - 1 })}>↑</button>
                <button type="button" data-queue-action="down" aria-label={`${t('musicList.moveDown')}: ${row().index + 1} · ${row().entry.title}`} disabled={disabled() || row().index === props.state.items.length - 1} onClick={() => run({ action: 'move', ...target(), toIndex: row().index + 1 })}>↓</button>
                <button type="button" data-queue-action="remove" aria-label={`${t('nowPlaying.removeFromQueue')}: ${row().index + 1} · ${row().entry.title}`} disabled={disabled()} onClick={() => run({ action: 'remove', ...target() })}>×</button>
              </div></Show>
          </div></Show>;
        }}</For>
      </div>
    </div>
  </section>;
}
