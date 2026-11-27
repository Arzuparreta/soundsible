import { createMemo, createSignal, onCleanup, onMount, type Accessor, type JSX } from 'solid-js';
import { CollectionRows } from '../../components/CollectionView';
import { useTvFocus } from '../nav/spatial';
import styles from '../styles/tv.module.css';

interface TvVirtualListProps<T> {
  items: readonly T[];
  groupId: string;
  order: number;
  initialIndex?: number;
  itemKey?: (item: T) => string;
  railEdge?: boolean;
  insideModal?: boolean;
  renderRow: (item: Accessor<T>, index: Accessor<number>, tvId: Accessor<string>) => JSX.Element;
}

export function tvListItemId(groupId: string, key: string | number): string {
  return `${groupId}-item-${key}`;
}

export function TvVirtualList<T>(props: TvVirtualListProps<T>) {
  const focus = useTvFocus();
  const [pending, setPending] = createSignal<number | undefined>(props.initialIndex);
  const [height, setHeight] = createSignal(102);
  let group!: HTMLDivElement;
  let sizeProbe!: HTMLDivElement;
  let disposed = false;
  const idAt = (index: number) => tvListItemId(props.groupId, props.itemKey?.(props.items[index]) ?? index);
  const indexOf = (id: string | null) => {
    const prefix = tvListItemId(props.groupId, '');
    if (!id?.startsWith(prefix)) return -1;
    if (props.itemKey) return props.items.findIndex((_, index) => idAt(index) === id);
    const index = Number(id.slice(prefix.length));
    return Number.isInteger(index) && index < props.items.length ? index : -1;
  };
  const pinned = createMemo(() => pending() ?? indexOf(focus.activeId()));

  function focusIndex(index: number): boolean {
    if (index < 0 || index >= props.items.length) return false;
    const id = idAt(index);
    if (focus.focusById(id, { rememberContent: !props.insideModal })) {
      setPending(undefined);
      return true;
    }
    setPending(index);
    // The shared range mounts the pinned row before focus and scroll are applied.
    queueMicrotask(() => {
      if (disposed || pending() !== index) return;
      focus.focusById(id, { rememberContent: !props.insideModal });
      setPending(undefined);
    });
    return true;
  }

  onMount(() => {
    const syncHeight = () => { if (sizeProbe.offsetHeight) setHeight(sizeProbe.offsetHeight); };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(syncHeight);
    observer?.observe(sizeProbe);
    syncHeight();
    const unregister = focus.registerVirtualGroup(props.groupId, {
      focusIndex,
      focusId: id => focusIndex(indexOf(id)),
      onMove(index, direction) {
        if (direction === 'left') {
          return props.railEdge === false || props.insideModal ? { handled: true } : { handled: false, escape: 'left' };
        }
        if (direction === 'right') return { handled: true };
        const next = index + (direction === 'up' ? -1 : 1);
        return focusIndex(next) ? { handled: true } : { handled: false, escape: direction };
      },
    });
    onCleanup(() => {
      disposed = true;
      unregister();
      observer?.disconnect();
    });
  });

  return (
    <div
      ref={group}
      class={styles.tvTrackList}
      data-tv-group-container={props.groupId}
      data-tv-group-kind="list"
      data-tv-group-order={String(props.order)}
      data-tv-rail-edge={props.railEdge === false ? 'none' : undefined}
      role="list"
    >
      <div ref={sizeProbe} class={styles.tvRowSize} aria-hidden="true" />
      <CollectionRows
        items={props.items}
        itemKey={props.itemKey}
        scrollElement={() => group.closest<HTMLElement>('[data-tv-scroll-y]')}
        rowHeight={height()}
        overscan={3}
        keepMountedIndex={pinned()}
      >
        {(item, index) => props.renderRow(item, index, () => idAt(index()))}
      </CollectionRows>
    </div>
  );
}
