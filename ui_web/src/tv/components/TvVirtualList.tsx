import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { useTvFocus } from '../nav/spatial';
import styles from '../styles/tv.module.css';

interface TvVirtualListProps<T> {
  items: readonly T[];
  groupId: string;
  order: number;
  maxVisible?: number;
  initialIndex?: number;
  railEdge?: boolean;
  insideModal?: boolean;
  renderRow: (item: T, index: number, tvId: string) => JSX.Element;
}

const DEFAULT_MAX_VISIBLE = 16;

export function TvVirtualList<T>(props: TvVirtualListProps<T>) {
  const focus = useTvFocus();
  const visibleCount = () => props.maxVisible ?? DEFAULT_MAX_VISIBLE;
  const initialStart = Math.max(
    0,
    Math.min(
      Math.max(0, props.items.length - visibleCount()),
      (props.initialIndex ?? 0) - 2,
    ),
  );
  const [windowStart, setWindowStart] = createSignal(initialStart);

  createEffect(() => {
    const maxStart = Math.max(0, props.items.length - visibleCount());
    if (windowStart() > maxStart) setWindowStart(maxStart);
  });

  const windowSlice = createMemo(() => {
    const start = windowStart();
    const end = Math.min(props.items.length, start + visibleCount());
    return {
      start,
      end,
      rows: props.items.slice(start, end),
      remainingAfter: Math.max(0, props.items.length - end),
    };
  });

  function ensureWindowContains(index: number): void {
    const count = visibleCount();
    const start = windowStart();
    if (index < start) {
      setWindowStart(Math.max(0, index));
    } else if (index >= start + count) {
      setWindowStart(Math.max(0, index - count + 1));
    }
  }

  onMount(() => {
    const unregister = focus.registerVirtualGroup(props.groupId, {
      onMove(currentIndex, direction) {
        if (direction === 'left') {
          if (props.railEdge !== false && !props.insideModal) {
            return { handled: false, escape: 'left' };
          }
          return { handled: true };
        }
        if (direction === 'right') {
          return { handled: true };
        }
        if (direction === 'up') {
          if (currentIndex <= 0) {
            return { handled: false, escape: 'up' };
          }
          const next = currentIndex - 1;
          ensureWindowContains(next);
          queueMicrotask(() => {
            focus.focusById(`${props.groupId}-item-${next}`, {
              rememberContent: !props.insideModal,
            });
          });
          return { handled: true };
        }
        if (direction === 'down') {
          if (currentIndex >= props.items.length - 1) {
            return { handled: false, escape: 'down' };
          }
          const next = currentIndex + 1;
          ensureWindowContains(next);
          queueMicrotask(() => {
            focus.focusById(`${props.groupId}-item-${next}`, {
              rememberContent: !props.insideModal,
            });
          });
          return { handled: true };
        }
        return { handled: false };
      },
      focusIndex(index) {
        const clamped = Math.max(0, Math.min(index, props.items.length - 1));
        ensureWindowContains(clamped);
        queueMicrotask(() => {
          focus.focusById(`${props.groupId}-item-${clamped}`, {
            rememberContent: !props.insideModal,
          });
        });
        return true;
      },
    });
    onCleanup(unregister);
  });

  return (
    <div
      class={styles.tvTrackList}
      data-tv-group-container={props.groupId}
      data-tv-group-kind="list"
      data-tv-group-order={String(props.order)}
      data-tv-rail-edge={props.railEdge === false ? 'none' : undefined}
      role="list"
    >
      <Show when={windowSlice().start > 0}>
        <div
          aria-hidden="true"
          style={{
            'flex-shrink': '0',
            height: `calc((var(--tv-row-h) + var(--tv-gap-xs)) * ${windowSlice().start})`,
          }}
        />
      </Show>
      <div class={styles.tvVirtualViewport}>
        <For each={windowSlice().rows}>
          {(item, localIdx) => {
            const logicalIdx = () => windowSlice().start + localIdx();
            const tvId = () => `${props.groupId}-item-${logicalIdx()}`;
            return props.renderRow(item, logicalIdx(), tvId());
          }}
        </For>
      </div>
      <Show when={windowSlice().remainingAfter > 0}>
        <div
          aria-hidden="true"
          style={{
            'flex-shrink': '0',
            height: `calc((var(--tv-row-h) + var(--tv-gap-xs)) * ${windowSlice().remainingAfter})`,
          }}
        />
      </Show>
    </div>
  );
}
