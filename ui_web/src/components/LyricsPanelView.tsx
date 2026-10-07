import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { api } from '../lib/api';
import { pageVisible } from '../lib/pageVisibility';
import { activeLineIndex, parseLrc, timingFits } from '../lib/lrc';
import { isPodcastTrack } from '../lib/track';
import { createResponsiveTap } from '../lib/responsiveTap';
import { t } from '../lib/i18n';
import { toast } from '../lib/toast';
import type { Track, LyricsResponse } from '../types/music';
import styles from './LyricsPanel.module.css';

/**
 * Lyrics tab of the Now Playing side panel. Follows whatever is playing:
 * library tracks hit the engine's cached LRCLIB lookup; previews (discover /
 * YouTube) are looked up by metadata. When synced (LRC) lyrics exist the
 * current line is highlighted and kept centred as the song advances; a tap on
 * any line seeks there. Plain lyrics render as a static scrollable text.
 *
 * Timed lines belong to one cut of a song. When the recording playing is
 * another — a music video with an intro, say — following them would run ahead
 * of the singer, so the panel shows them unhighlighted and asks for a tap on
 * the line being sung. That tap is the recording's offset, kept by the engine
 * for this audio; "Adjust timing" asks for it again on lines that do follow.
 */
export interface LyricsPlayback {
  currentTrack(): Track | null;
  currentTime(): number;
  inLibrary(track: Track): boolean;
  saved(track: Track): boolean;
  seek(seconds: number): void;
  /** Seconds of the audio actually playing, once the player knows them. */
  mediaDuration?(): number | undefined;
}

/** How long a listener takes to tap the line they hear begin. */
const TAP_REACTION_MS = 250;
export function LyricsPanelView(props: {
  playback: LyricsPlayback;
  scrollRef?: (element: HTMLDivElement) => void;
  variant?: 'compact' | 'stage';
}) {
  const current = createMemo(() => props.playback.currentTrack() ?? null);

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
      sourceKind: cur.playback_source_kind,
      youtubeId: cur.youtube_id ?? (cur.source === 'preview' ? cur.id : undefined),
      inLibrary: props.playback.inLibrary(cur),
      saved: props.playback.saved(cur),
    };
  });

  let activeLookup: AbortController | undefined;
  onCleanup(() => activeLookup?.abort());
  const [lyrics, { refetch }] = createResource(lyricsKey, async (key): Promise<LyricsResponse> => {
    activeLookup?.abort();
    const lookup = new AbortController(); activeLookup = lookup;
    // Cold LRCLIB calls run on two dedicated, zero-backlog server workers.
    // Polling keeps this resource in its loading state without tying up an API
    // worker while LRCLIB responds (typically several seconds on a cold miss).
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const result = key.inLibrary
        ? await api.getTrackLyrics(key.id, { signal: lookup.signal })
        : await api.getLyricsByMetadata({
            artist: key.artist,
            title: key.title,
            album: key.album,
            duration: key.duration,
            sourceKind: key.sourceKind ?? undefined,
            youtubeId: key.youtubeId ?? undefined,
            persist: key.saved,
          }, { signal: lookup.signal });
      if (lookup.signal.aborted) throw new DOMException('Lyrics lookup cancelled', 'AbortError');
      if (!result.pending) return result;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Lyrics lookup cancelled', 'AbortError')); };
        const timer = window.setTimeout(() => { lookup.signal.removeEventListener('abort', abort); resolve(); }, 750);
        lookup.signal.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error('Lyrics lookup timed out');
  });

  createEffect(() => { if (!lyricsKey()) activeLookup?.abort(); });

  const parsed = createMemo(() => {
    const synced = lyrics()?.synced;
    return synced ? parseLrc(synced) : [];
  });

  // ── Timing: follow the lines, or have the listener line them up ──
  const [offsetMs, setOffsetMs] = createSignal<number | null>(null);
  const [adjusting, setAdjusting] = createSignal(false);
  createEffect(on(() => lyrics(), (res) => {
    setOffsetMs(res?.offset_ms ?? null);
    setAdjusting(false);
  }));
  const timingTrusted = createMemo(() => {
    if (offsetMs() !== null) return true;
    const res = lyrics();
    if (!res || res.timing_safe === false) return false;
    return timingFits(props.playback.mediaDuration?.(), res.synced_duration);
  });
  const aligning = createMemo(() => parsed().length > 0 && (adjusting() || !timingTrusted()));
  /** Seconds the lines sit later in this recording than their timing says. */
  const shift = () => (offsetMs() ?? 0) / 1000;

  const saveOffset = async (value: number | null) => {
    const key = lyricsKey();
    setOffsetMs(value);
    setAdjusting(false);
    const target = !key ? null : key.inLibrary ? { trackId: key.id } : key.youtubeId ? { youtubeId: key.youtubeId } : null;
    // Without an audio to keep it for, the correction lasts while this plays.
    if (!target) return;
    try {
      await api.setLyricsOffset({ ...target, offsetMs: value });
    } catch {
      toast.error(t('lyricsPanel.timingSaveFailed'));
    }
  };
  const alignTo = (lineTime: number) =>
    saveOffset(Math.round((props.playback.currentTime() - lineTime) * 1000) - TAP_REACTION_MS);

  const activeIdx = createMemo<number>((previous) => aligning() ? -1 : pageVisible()
    ? activeLineIndex(parsed(), props.playback.currentTime() - shift()) : previous ?? -1);

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
    if (!pageVisible() || !el || Date.now() < holdUntil) return;
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
    if (!pageVisible()) { stopFollow(); aligned = false; return; }
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
    return !!res && res.status !== 'unavailable' && !res.synced && !res.plain && !res.instrumental;
  });

  return (
    <div
      classList={{ [styles.body]: true, [styles.stage]: props.variant === 'stage' }}
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
            <Show
              when={lyrics()?.status !== 'unavailable'}
              fallback={
                <div class={styles.unavailable} role="status">
                  <p class={styles.hint}>{t('lyricsPanel.unavailable')}</p>
                  <button type="button" onClick={() => void refetch()}>
                    {t('lyricsPanel.retry')}
                  </button>
                </div>
              }
            >
              <Show when={!lyrics()?.instrumental} fallback={<p class={styles.hint}>{t('lyricsPanel.instrumental')}</p>}>
                <Show when={!empty()} fallback={<p class={styles.hint}>{t('lyricsPanel.notFound')}</p>}>
                  <Show
                    when={parsed().length > 0}
                    fallback={<pre class={styles.plain}>{lyrics()?.plain ?? ''}</pre>}
                  >
                    <Show when={aligning()}>
                      <div class={styles.timing} role="status" data-lyrics-timing="">
                        <p>{timingTrusted() ? t('lyricsPanel.adjustHint') : t('lyricsPanel.alignHint')}</p>
                        <Show when={adjusting() || offsetMs() !== null}>
                          <div class={styles.timingActions}>
                            <Show when={adjusting()}>
                              <button type="button" onClick={() => setAdjusting(false)}>{t('lyricsPanel.cancelAdjust')}</button>
                            </Show>
                            <Show when={offsetMs() !== null}>
                              <button type="button" onClick={() => void saveOffset(null)}>{t('lyricsPanel.resetTiming')}</button>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    </Show>
                    <div class={styles.synced}>
                      <For each={parsed()}>
                        {(line, i) => {
                          const tap = createResponsiveTap({
                            onTap: () => {
                              // The tap that seeks also set a touch hold; drop it
                              // so the view follows the new position immediately.
                              holdUntil = 0;
                              if (aligning()) void alignTo(line.time);
                              else props.playback.seek(line.time + shift());
                            },
                          });
                          return (
                            <button
                              type="button"
                              aria-current={i() === activeIdx() ? 'true' : undefined}
                              data-line={i()}
                              data-pressable
                              classList={{
                                [styles.line]: true,
                                [styles.lineActive]: i() === activeIdx(),
                                [styles.linePast]: i() < activeIdx(),
                              }}
                              {...tap}
                            >
                              {line.text || '♪'}
                            </button>
                          );
                        }}
                      </For>
                      <Show when={!aligning()}>
                        <button type="button" class={styles.adjust} onClick={() => setAdjusting(true)}>
                          {t('lyricsPanel.adjust')}
                        </button>
                      </Show>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
