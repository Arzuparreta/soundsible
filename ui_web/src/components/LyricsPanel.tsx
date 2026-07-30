import { createEffect, createMemo, createResource, For, on, onCleanup, onMount, Show } from 'solid-js';
import { api } from '../lib/api';
import { actions, state } from '../stores';
import { activeLineIndex, parseLrc } from '../lib/lrc';
import { isPodcastTrack } from '../lib/track';
import { t } from '../lib/i18n';
import type { LyricsResponse } from '../types/music';
import styles from './LyricsPanel.module.css';

/**
 * Lyrics tab of the Now Playing side panel. Follows whatever is playing:
 * library tracks hit the engine's cached LRCLIB lookup; previews (discover /
 * YouTube) are looked up by metadata. When synced (LRC) lyrics exist the
 * current line is highlighted and kept centred as the song advances; a tap on
 * any line seeks there. Plain lyrics render as a static scrollable text.
 */
export function LyricsPanel(props: { scrollRef?: (element: HTMLDivElement) => void } = {}) {
  const current = createMemo(() => state.playback.currentTrack ?? null);

  // Refetch only when the playing track (not the position) changes.
  const lyricsKey = createMemo(() => {
    const cur = current();
    if (!cur || isPodcastTrack(cur) || !cur.artist || !cur.title) return null;
    return {
      id: cur.id,
      artist: cur.artist,
      title: cur.title,
      album: cur.album,
      duration: cur.duration,
      inLibrary: state.library.some((tk) => tk.id === cur.id),
    };
  });

  const [lyrics] = createResource(lyricsKey, async (key): Promise<LyricsResponse> => {
    // Cold LRCLIB calls run on two dedicated, zero-backlog server workers.
    // Polling keeps this resource in its loading state without tying up an API
    // worker while LRCLIB responds (typically several seconds on a cold miss).
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const result = key.inLibrary
        ? await api.getTrackLyrics(key.id)
        : await api.getLyricsByMetadata({
            artist: key.artist,
            title: key.title,
            album: key.album,
            duration: key.duration,
          });
      if (!result.pending) return result;
      await new Promise((resolve) => window.setTimeout(resolve, 750));
    }
    throw new Error('Lyrics lookup timed out');
  });

  const parsed = createMemo(() => {
    const synced = lyrics()?.synced;
    return synced ? parseLrc(synced) : [];
  });
  const activeIdx = createMemo(() => activeLineIndex(parsed(), state.playback.currentTime));

  // ── Auto-scroll: keep the active line centred, but yield to the user ──
  //
  // The container is driven by its own scrollTop rather than scrollIntoView.
  // Every mobile surface that shows lyrics (the Now Playing sheet, Auto's
  // cover) is a fixed, transformed overlay, and scrollIntoView on a nested
  // scroller inside one is unreliable there: it walks up the ancestor chain and
  // ends up scrolling nothing, so the lines sat frozen while the song moved on.
  // Tweening scrollTop ourselves is exact, keeps every ancestor still, and
  // makes "is this scroll mine or the user's?" answerable by position.
  const FOLLOW_MS = 420;
  /** How long a real user scroll owns the view before playback takes it back. */
  const USER_HOLD_MS = 4000;
  /** A touch alone only parks the animation; scrolling extends it to the above. */
  const TOUCH_HOLD_MS = 800;

  let bodyEl: HTMLDivElement | undefined;
  let holdUntil = 0;
  let rafId = 0;
  /** Where our own tween left the scroller, so its scroll events are ignorable. */
  let ownScrollTop = 0;
  /** The first alignment of a set of lyrics jumps; the rest glide. */
  let aligned = false;

  const stopFollow = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  };

  const glideTo = (el: HTMLDivElement, top: number, smooth: boolean) => {
    stopFollow();
    if (!smooth || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      el.scrollTop = top;
      ownScrollTop = el.scrollTop;
      return;
    }
    const from = el.scrollTop;
    const startedAt = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - startedAt) / FOLLOW_MS);
      el.scrollTop = from + (top - from) * (1 - (1 - p) ** 3);
      ownScrollTop = el.scrollTop;
      rafId = p < 1 ? requestAnimationFrame(step) : 0;
    };
    rafId = requestAnimationFrame(step);
  };

  const follow = (smooth: boolean) => {
    const el = bodyEl;
    if (!el || Date.now() < holdUntil) return;
    const idx = activeIdx();
    if (idx < 0) return;
    const line = el.querySelector<HTMLElement>(`[data-line="${idx}"]`);
    // A surface that is laid out at zero height (mobile mounts the panel behind
    // the cover toggle) has nothing to scroll yet; the observer below retries.
    if (!line || el.clientHeight <= 0) return;
    const box = el.getBoundingClientRect();
    const rect = line.getBoundingClientRect();
    const centred = el.scrollTop + (rect.top - box.top) - (box.height - rect.height) / 2;
    const target = Math.min(Math.max(centred, 0), Math.max(0, el.scrollHeight - el.clientHeight));
    if (Math.abs(target - el.scrollTop) < 2) {
      ownScrollTop = el.scrollTop;
      aligned = true;
      return;
    }
    glideTo(el, target, smooth && aligned);
    aligned = true;
  };

  const onScroll = () => {
    const el = bodyEl;
    // Our tween writes scrollTop frame by frame; only a position we did not put
    // there is the user's. Momentum flings keep refreshing the hold on their own.
    if (!el || Math.abs(el.scrollTop - ownScrollTop) <= 2) return;
    stopFollow();
    holdUntil = Date.now() + USER_HOLD_MS;
  };

  const onUserTouch = () => {
    stopFollow();
    holdUntil = Math.max(holdUntil, Date.now() + TOUCH_HOLD_MS);
  };

  // New lyrics (track change, or a lookup landing) start clean: no stale hold,
  // and the first placement jumps rather than gliding in from the old position.
  createEffect(on(parsed, () => {
    aligned = false;
    holdUntil = 0;
  }));

  createEffect(() => {
    parsed();
    activeIdx();
    follow(true);
  });

  onMount(() => {
    const el = bodyEl;
    if (!el) return;
    const opts = { passive: true } as const;
    el.addEventListener('pointerdown', onUserTouch, opts);
    el.addEventListener('touchstart', onUserTouch, opts);
    el.addEventListener('wheel', onUserTouch, opts);
    // Revealing the panel (mobile cover toggle, Auto handoff, a rotation) is a
    // resize, not a lyric change — re-centre without animating in from the top.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => follow(false)) : null;
    observer?.observe(el);
    onCleanup(() => {
      stopFollow();
      observer?.disconnect();
      el.removeEventListener('pointerdown', onUserTouch);
      el.removeEventListener('touchstart', onUserTouch);
      el.removeEventListener('wheel', onUserTouch);
    });
  });

  const empty = createMemo(() => {
    const res = lyrics();
    return !!res && !res.synced && !res.plain && !res.instrumental;
  });

  return (
    <div
      class={styles.body}
      data-lyrics-scroll=""
      ref={(element) => {
        bodyEl = element;
        props.scrollRef?.(element);
      }}
      onScroll={onScroll}
    >
      <Show when={current()} fallback={<p class={styles.hint}>{t('lyricsPanel.noTrack')}</p>}>
        <Show when={!lyrics.loading} fallback={<div class={styles.loading} aria-label={t('lyricsPanel.loading')} />}>
          <Show when={!lyrics.error} fallback={<p class={styles.hint}>{t('lyricsPanel.error')}</p>}>
            <Show when={!lyrics()?.instrumental} fallback={<p class={styles.hint}>{t('lyricsPanel.instrumental')}</p>}>
              <Show when={!empty()} fallback={<p class={styles.hint}>{t('lyricsPanel.notFound')}</p>}>
                <Show
                  when={parsed().length > 0}
                  fallback={<pre class={styles.plain}>{lyrics()?.plain ?? ''}</pre>}
                >
                  <div class={styles.synced}>
                    <For each={parsed()}>
                      {(line, i) => (
                        <button
                          type="button"
                          data-line={i()}
                          classList={{
                            [styles.line]: true,
                            [styles.lineActive]: i() === activeIdx(),
                            [styles.linePast]: i() < activeIdx(),
                          }}
                          onClick={() => {
                            // The tap that seeks also set a touch hold; drop it
                            // so the view follows the new position immediately.
                            holdUntil = 0;
                            actions.seek(line.time);
                          }}
                        >
                          {line.text || '♪'}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
