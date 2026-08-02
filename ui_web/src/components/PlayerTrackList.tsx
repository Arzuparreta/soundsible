import { For, Show, type JSX } from 'solid-js';
import { createResponsiveTap } from '../lib/responsiveTap';
import styles from './PlayerTrackList.module.css';

export interface PlayerTrackListEntry {
  id: string;
  title: string;
  artist: string;
  cover?: string;
  position?: string | number;
  current?: boolean;
  paused?: boolean;
  locked?: boolean;
  annotation?: string;
  badge?: string;
  onActivate?: () => void;
  trailing?: JSX.Element;
  draggable?: boolean;
  onDragStart?: (event: DragEvent) => void;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  before?: JSX.Element;
  onCarry?: () => void;
}

export interface PlayerTrackListSection {
  id: string;
  label?: string;
  count?: number;
  entries: PlayerTrackListEntry[];
  footer?: JSX.Element;
}

export function PlayerTrackList(props: {
  title: string;
  count: number;
  sections: PlayerTrackListSection[];
  empty: string;
  dragHandle?: JSX.Element;
  headAction?: {
    label: string;
    disabled?: boolean;
    onClick: () => void;
  };
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  setScrollerRef?: (element: HTMLDivElement) => void;
}) {
  return (
    <div class={styles.panel}>
      <header class={styles.head} onDragOver={props.onDragOver} onDrop={props.onDrop}>
        <span class={styles.heading}>
          {props.dragHandle}
          <h2>{props.title}</h2>
          <span class={styles.count}>{props.count}</span>
        </span>
        <Show when={props.headAction}>
          {(action) => (
            <button
              class={styles.headAction}
              type="button"
              disabled={action().disabled}
              onClick={action().onClick}
            >
              {action().label}
            </button>
          )}
        </Show>
      </header>
      <div class={styles.rows} ref={props.setScrollerRef}>
        <Show when={props.sections.some((section) => section.entries.length > 0)} fallback={<p class={styles.empty}>{props.empty}</p>}>
          <For each={props.sections}>
            {(section) => (
              <Show when={section.entries.length > 0}>
                <section class={styles.section}>
                  <Show when={section.label}>
                    <div class={styles.sectionHead}>
                      <span>{section.label}</span>
                      <Show when={section.count !== undefined}>
                        <span class={styles.sectionCount}>{section.count}</span>
                      </Show>
                    </div>
                  </Show>
                  <For each={section.entries}>
                    {(entry) => <>{entry.before}<PlayerTrackListRow entry={entry} /></>}
                  </For>
                  {section.footer}
                </section>
              </Show>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

function PlayerTrackListRow(props: { entry: PlayerTrackListEntry }) {
  const disabled = () => Boolean(props.entry.current || props.entry.locked || !props.entry.onActivate);
  const tap = createResponsiveTap({
    disabled,
    onTap: () => props.entry.onActivate?.(),
  });
  let carryTimer: number | undefined;
  const cancelCarry = () => {
    if (carryTimer !== undefined) window.clearTimeout(carryTimer);
    carryTimer = undefined;
  };
  return (
    <div
      class={styles.row}
      data-current={props.entry.current ? '' : undefined}
      data-locked={props.entry.locked ? '' : undefined}
      draggable={props.entry.draggable}
      onDragStart={props.entry.onDragStart}
      onDragOver={props.entry.onDragOver}
      onDrop={props.entry.onDrop}
      onPointerDown={() => {
        if (!props.entry.onCarry) return;
        cancelCarry();
        carryTimer = window.setTimeout(() => props.entry.onCarry?.(), 460);
      }}
      onPointerMove={cancelCarry}
      onPointerUp={cancelCarry}
      onPointerCancel={cancelCarry}
    >
      <button class={styles.main} type="button" disabled={disabled()} data-pressable {...tap}>
        <span class={styles.position}>
          <Show when={!props.entry.current} fallback={
            <span class={styles.eq} data-paused={props.entry.paused ? '' : undefined} aria-hidden="true"><i /><i /><i /></span>
          }>
            {props.entry.position ?? ''}
          </Show>
        </span>
        <span
          class={styles.cover}
          style={{ 'background-image': props.entry.cover ? `url("${props.entry.cover}")` : undefined }}
          aria-hidden="true"
        />
        <span class={styles.meta}>
          <span class={styles.title}>{props.entry.title}</span>
          <span class={styles.artist}>{props.entry.artist}</span>
          <Show when={props.entry.annotation}>
            <small class={styles.annotation}>{props.entry.annotation}</small>
          </Show>
          <Show when={props.entry.badge}>
            <small class={styles.badge}>{props.entry.badge}</small>
          </Show>
        </span>
      </button>
      <Show when={props.entry.trailing}>
        <span class={styles.trailing}>{props.entry.trailing}</span>
      </Show>
    </div>
  );
}

export function PlayerTrackListMore(props: { label: string; onClick: () => void }) {
  return <button class={styles.more} type="button" onClick={props.onClick}>{props.label}</button>;
}
