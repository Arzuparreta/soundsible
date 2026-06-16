import { createMemo, createSignal, For, Show, onMount, type JSX } from 'solid-js';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { state, actions } from '../stores';
import SongRow from './SongRow';
import { coverUrl } from '../lib/media';
import type { Track } from '../types/music';
import styles from './TrackList.module.css';

/**
 * Reusable virtualized song list. Shared by Home, Favourites and Search.
 * Reads playback/favourites/actions from the single store; only visible rows
 * render, and only the affected node updates on play/favourite changes.
 */
export default function TrackList(props: { tracks: Track[]; loading?: boolean; empty?: JSX.Element }) {
  let scrollRef: HTMLDivElement | undefined;
  const favSet = createMemo(() => new Set(state.favorites));

  // Row height follows the adaptive --row-h token (56 mobile / 44 desktop).
  const [rowH, setRowH] = createSignal(56);
  onMount(() => {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'), 10);
    if (Number.isFinite(v) && v > 0) setRowH(v);
  });

  const virtualizer = createVirtualizer({
    get count() {
      return props.tracks.length;
    },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => rowH(),
    overscan: 10,
  });

  return (
    <div ref={scrollRef} class={styles.scroll}>
      <Show
        when={!(props.loading && props.tracks.length === 0)}
        fallback={<For each={Array.from({ length: 10 })}>{() => <div class={styles.skeleton} />}</For>}
      >
        <Show
          when={props.tracks.length > 0}
          fallback={props.empty ?? <p class={styles.empty}>Nada por aquí.</p>}
        >
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
            <For each={virtualizer.getVirtualItems()}>
              {(vi) => {
                const track = props.tracks[vi.index];
                return (
                  <Show when={track}>
                    <div
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${vi.size}px`,
                        transform: `translateY(${vi.start}px)`,
                      }}
                    >
                      <SongRow
                        track={track!}
                        index={vi.index + 1}
                        cover={coverUrl(track!.id)}
                        active={state.playback.currentTrack?.id === track!.id}
                        favorite={favSet().has(track!.id)}
                        onPlay={() => actions.playFrom(props.tracks, vi.index)}
                        onToggleFavorite={actions.toggleFavourite}
                      />
                    </div>
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
