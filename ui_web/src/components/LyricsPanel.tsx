import { createEffect, createMemo, createResource, For, Show } from 'solid-js';
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
export function LyricsPanel() {
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
  let bodyEl: HTMLDivElement | undefined;
  let userScrollUntil = 0;
  let programmaticScroll = false;

  const onScroll = () => {
    if (programmaticScroll) return;
    userScrollUntil = Date.now() + 4000;
  };

  createEffect(() => {
    const idx = activeIdx();
    if (idx < 0 || !bodyEl) return;
    if (Date.now() < userScrollUntil) return;
    const line = bodyEl.querySelector<HTMLElement>(`[data-line="${idx}"]`);
    if (!line) return;
    programmaticScroll = true;
    line.scrollIntoView({ block: 'center', behavior: 'smooth' });
    window.setTimeout(() => {
      programmaticScroll = false;
    }, 600);
  });

  const empty = createMemo(() => {
    const res = lyrics();
    return !!res && !res.synced && !res.plain && !res.instrumental;
  });

  return (
    <div class={styles.body} ref={bodyEl} onScroll={onScroll}>
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
                          onClick={() => actions.seek(line.time)}
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
