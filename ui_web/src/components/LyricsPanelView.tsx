import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { api } from '../lib/api';
import { pageVisible } from '../lib/pageVisibility';
import {
  activeLineIndex,
  parseLrc,
  richToDisplayLines,
  segmentFill,
  timingFits,
  type DisplayLyricLine,
} from '../lib/lrc';
import { lookupLyrics } from '../lib/lyricsLookup';
import { isPodcastTrack } from '../lib/track';
import { prefersReducedMotion } from '../lib/prefersReducedMotion';
import { createResponsiveTap } from '../lib/responsiveTap';
import { t } from '../lib/i18n';
import { toast } from '../lib/toast';
import type { Track, LyricsResponse } from '../types/music';
import styles from './LyricsPanel.module.css';

/**
 * Lyrics tab of the Now Playing side panel. Follows whatever is playing:
 * library tracks hit the engine's cached lookup (LRCLIB, then lrc.red / NetEase)
 * with non-blocking Phase 2 word/syllable enrichment; previews (discover /
 * YouTube) are looked up by metadata. Lines (or rich timing) from lrc.red end
 * with a link to it, as its terms ask. When synced lyrics exist the current
 * line is highlighted (and animated per syllable/word when rich timing is
 * available) and kept centred as the song advances; a tap on any line seeks
 * there. Plain lyrics render as a static scrollable text.
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
  /** Whether playback is actively advancing (drives 60 fps syllable sweep). */
  isPlaying?(): boolean;
  inLibrary(track: Track): boolean;
  saved(track: Track): boolean;
  seek(seconds: number): void;
  /** Seconds of the audio actually playing, once the player knows them. */
  mediaDuration?(): number | undefined;
}

/** How long a listener takes to tap the line they hear begin. */
const TAP_REACTION_MS = 250;
/** Gentle background polls while Phase 2 syllable enrichment runs server-side. */
const ENRICH_POLL_DELAYS_MS = [1200, 2500, 4500];
/** Maximum seconds the 60 fps clock may extrapolate past the last media tick. */
const MAX_CLOCK_EXTRAPOLATION_SEC = 0.6;

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

  const fetchOnce = (key: NonNullable<ReturnType<typeof lyricsKey>>, signal: AbortSignal) => (
    key.inLibrary
      ? api.getTrackLyrics(key.id, { signal })
      : api.getLyricsByMetadata({
          artist: key.artist,
          title: key.title,
          album: key.album,
          duration: key.duration,
          sourceKind: key.sourceKind ?? undefined,
          youtubeId: key.youtubeId ?? undefined,
          persist: key.saved,
        }, { signal })
  );

  let activeLookup: AbortController | undefined;
  onCleanup(() => activeLookup?.abort());
  const [lyrics, { refetch, mutate }] = createResource(lyricsKey, async (key): Promise<LyricsResponse> => {
    activeLookup?.abort();
    const lookup = new AbortController(); activeLookup = lookup;
    return lookupLyrics((signal) => fetchOnce(key, signal), lookup.signal);
  });

  createEffect(() => { if (!lyricsKey()) activeLookup?.abort(); });

  // Phase 2 background enrichment: when the engine served line/plain lyrics
  // immediately and started rich syllable/word enrichment, check a few times
  // quietly and upgrade the rendered lyrics in place without a loading flash.
  createEffect(() => {
    const key = lyricsKey();
    const res = lyrics();
    if (!key || !res || res.status !== 'ready' || !res.enriching || res.rich_synced) return;
    const controller = new AbortController();
    let timer = 0;
    let attempt = 0;
    const schedule = () => {
      if (controller.signal.aborted || attempt >= ENRICH_POLL_DELAYS_MS.length) return;
      timer = window.setTimeout(async () => {
        attempt += 1;
        try {
          const updated = await fetchOnce(key, controller.signal);
          if (controller.signal.aborted || lyricsKey() !== key) return;
          if (updated && updated.status === 'ready') {
            if (updated.rich_synced || !updated.enriching) {
              mutate(updated);
              return;
            }
          }
        } catch {
          return;
        }
        schedule();
      }, ENRICH_POLL_DELAYS_MS[attempt]);
    };
    schedule();
    onCleanup(() => {
      window.clearTimeout(timer);
      controller.abort();
    });
  });

  const richLines = createMemo(() => richToDisplayLines(lyrics()?.rich_synced));

  const parsed = createMemo<DisplayLyricLine[]>(() => {
    const rich = richLines();
    if (rich.length > 0) return rich;
    const synced = lyrics()?.synced;
    return synced ? parseLrc(synced).map((line) => ({ time: line.time, text: line.text, words: null })) : [];
  });

  // ── Timing: follow the lines, or have the listener line them up ──
  const [offsetMs, setOffsetMs] = createSignal<number | null>(null);
  const [adjusting, setAdjusting] = createSignal(false);
  createEffect(on(lyricsKey, () => {
    setOffsetMs(null);
    setAdjusting(false);
  }));
  createEffect(on(() => lyrics()?.offset_ms, (next) => {
    if (next !== undefined) setOffsetMs(next ?? null);
  }));
  const timingTrusted = createMemo(() => {
    if (offsetMs() !== null) return true;
    const res = lyrics();
    if (!res || res.timing_safe === false) return false;
    return timingFits(props.playback.mediaDuration?.(), res.rich_synced?.dur ?? res.synced_duration);
  });
  const aligning = createMemo(() => parsed().length > 0 && (adjusting() || !timingTrusted()));
  /** Seconds the lines sit later in this recording than their timing says. */
  const shift = () => (offsetMs() ?? 0) / 1000;

  // 60 fps interpolated playback clock, active ONLY while rich syllable/word
  // lines are visible and actively playing. Zero rAF cost for line-only lyrics,
  // paused playback, hidden tabs, or reduced motion.
  const [smoothTime, setSmoothTime] = createSignal(props.playback.currentTime());
  let anchorPos = props.playback.currentTime();
  let anchorWall = performance.now();
  createEffect(() => {
    anchorPos = props.playback.currentTime();
    anchorWall = performance.now();
    setSmoothTime(anchorPos);
  });
  createEffect(() => {
    const active = richLines().length > 0
      && !aligning()
      && pageVisible()
      && (props.playback.isPlaying?.() ?? false)
      && !prefersReducedMotion();
    if (!active) return;
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = Math.max(0, Math.min(MAX_CLOCK_EXTRAPOLATION_SEC, (now - anchorWall) / 1000));
      setSmoothTime(anchorPos + elapsed);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  // Saves go out one after another, so the engine keeps the last one made;
  // only the latest may undo itself, so an older failure cannot bring back a
  // timing a newer save has already replaced.
  let saveGeneration = 0;
  let saveQueue: Promise<unknown> | null = null;
  const saveOffset = (value: number | null): Promise<void> => {
    const key = lyricsKey();
    const generation = ++saveGeneration;
    const previous = { offset: offsetMs(), adjusting: adjusting() };
    setOffsetMs(value);
    setAdjusting(false);
    const target = !key ? null : key.inLibrary ? { trackId: key.id } : key.youtubeId ? { youtubeId: key.youtubeId } : null;
    // Without an audio to keep it for, the correction lasts while this plays.
    if (!target) return Promise.resolve();
    const send = () => api.setLyricsOffset({ ...target, offsetMs: value });
    const request = saveQueue ? saveQueue.then(send) : send();
    const settled: Promise<unknown> = request.catch(() => {}).finally(() => {
      if (saveQueue === settled) saveQueue = null;
    });
    saveQueue = settled;
    return request.then(() => {}, () => {
      // Not saved, so not applied: the panel must not show a timing the engine
      // will not give back — unless something newer has happened since.
      if (generation === saveGeneration && lyricsKey() === key) {
        setOffsetMs(previous.offset);
        setAdjusting(previous.adjusting);
      }
      toast.error(t('lyricsPanel.timingSaveFailed'));
    });
  };
  const alignTo = (lineTime: number) =>
    saveOffset(Math.round((props.playback.currentTime() - lineTime) * 1000) - TAP_REACTION_MS);

  const effectiveTime = () => (richLines().length > 0 ? smoothTime() : props.playback.currentTime()) - shift();
  const activeIdx = createMemo<number>((previous) => aligning() ? -1 : pageVisible()
    ? activeLineIndex(parsed(), effectiveTime()) : previous ?? -1);

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
    if (!smooth || prefersReducedMotion()) {
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

  // New track starts clean: no stale hold, and the first placement jumps
  // rather than gliding in from the old position. Phase 2 rich upgrades on
  // the same track keep `aligned` intact so the view does not jump mid-song.
  createEffect(on(lyricsKey, () => {
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

  const credit = () => (
    <Show when={lyrics()?.provider === 'lrc.red'}>
      <a class={styles.credit} href="https://lrc.red" target="_blank" rel="noopener noreferrer">
        {t('lyricsPanel.source', { name: 'lrc.red' })}
      </a>
    </Show>
  );

  const empty = createMemo(() => {
    const res = lyrics();
    return !!res && res.status !== 'unavailable' && !res.synced && !res.rich_synced && !res.plain && !res.instrumental;
  });

  return (
    <div class={styles.frame}>
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
                      fallback={<><pre class={styles.plain}>{lyrics()?.plain ?? ''}</pre>{credit()}</>}
                    >
                      <div
                        class={styles.synced}
                        data-lyrics-granularity={lyrics()?.rich_synced?.granularity ?? 'line'}
                      >
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
                            const isPrimaryActive = () => i() === activeIdx();
                            const isRichActive = createMemo(() => {
                              if (!line.words || aligning()) return false;
                              if (isPrimaryActive()) return true;
                              if (line.endTime === undefined) return false;
                              const pos = effectiveTime();
                              return pos >= line.time && pos < line.endTime;
                            });
                            return (
                              <button
                                type="button"
                                aria-current={isPrimaryActive() ? 'true' : undefined}
                                data-line={i()}
                                data-pressable
                                classList={{
                                  [styles.line]: true,
                                  [styles.lineBg]: Boolean(line.bg),
                                  [styles.lineActive]: isPrimaryActive() || isRichActive(),
                                  [styles.lineRichActive]: isRichActive(),
                                  [styles.linePast]: !isRichActive() && i() < activeIdx(),
                                }}
                                {...tap}
                              >
                                <Show when={isRichActive() && line.words} fallback={line.text || '♪'}>
                                  {(words) => (
                                    <For each={words()}>
                                      {(word) => (
                                        <>
                                          <span class={styles.word}>
                                            <For each={word.segments}>
                                              {(seg) => {
                                                const fill = () => segmentFill(seg, effectiveTime() * 1000);
                                                const sweeping = () => {
                                                  const f = fill();
                                                  return f > 0 && f < 1 && !prefersReducedMotion();
                                                };
                                                return (
                                                  <span
                                                    data-syllable=""
                                                    classList={{
                                                      [styles.sylIdle]: fill() <= 0,
                                                      [styles.sylDone]: fill() >= 1 || (fill() > 0 && prefersReducedMotion()),
                                                      [styles.sylSweep]: sweeping(),
                                                    }}
                                                    style={sweeping()
                                                      ? { '--syl-fill': `${(fill() * 100).toFixed(1)}%` }
                                                      : undefined}
                                                  >
                                                    {seg.x}
                                                  </span>
                                                );
                                              }}
                                            </For>
                                          </span>
                                          {word.trailingSpace ? ' ' : ''}
                                        </>
                                      )}
                                    </For>
                                  )}
                                </Show>
                              </button>
                            );
                          }}
                        </For>
                        <Show when={!aligning()}>
                          <button type="button" class={styles.adjust} onClick={() => setAdjusting(true)}>
                            {t('lyricsPanel.adjust')}
                          </button>
                        </Show>
                        {credit()}
                      </div>
                    </Show>
                  </Show>
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
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
    </div>
  );
}
