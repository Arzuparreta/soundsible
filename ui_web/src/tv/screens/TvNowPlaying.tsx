import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { NextFilledIcon, PauseFilledIcon, PlayFilledIcon, PrevFilledIcon, QueueListIcon } from '../../components/icons';
import { Control } from '../../design/Control';
import { clockTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { trackCoverUrl } from '../../lib/media';
import { actions, state } from '../../stores';
import { TvArtwork } from '../components/TvArtwork';
import type { TvAction } from '../nav/input';
import { useTvFocus } from '../nav/spatial';
import { setDimActive, setQueueOpen } from '../state';
import styles from '../styles/tv.module.css';

interface TvNowPlayingProps {
  onNavigateHome: () => void;
  registerActionInterceptor: (handler: (action: TvAction) => boolean) => () => void;
}

const SEEK_STEP_SEC = 10;

export function TvNowPlaying(props: TvNowPlayingProps) {
  const focus = useTvFocus();
  const [seekPreviewSec, setSeekPreviewSec] = createSignal<number | null>(null);

  const track = () => state.playback.currentTrack;
  const durationSec = () => {
    const d = state.playback.duration || track()?.duration || 0;
    return Number.isFinite(d) && d > 0 ? d : 0;
  };
  const displayedPositionSec = () => seekPreviewSec() ?? state.playback.currentTime;
  const progressPct = () => {
    const dur = durationSec();
    if (!dur) return '0%';
    const clamped = Math.max(0, Math.min(dur, displayedPositionSec()));
    return `${Math.round((clamped / dur) * 100)}%`;
  };

  createEffect(() => {
    // Cancel uncommitted preview if focus moves off the seek control.
    if (focus.activeId() !== 'np-seek' && seekPreviewSec() !== null) {
      setSeekPreviewSec(null);
    }
  });

  function commitPreview(): void {
    const preview = seekPreviewSec();
    if (preview === null) return;
    actions.seek(preview);
    setSeekPreviewSec(null);
  }

  onMount(() => {
    const unregisterInterceptor = props.registerActionInterceptor((action) => {
      if (focus.activeId() !== 'np-seek') return false;
      const dur = durationSec();
      if (action === 'left' || action === 'right') {
        if (dur <= 0) return true;
        const base = seekPreviewSec() ?? state.playback.currentTime;
        const delta = action === 'right' ? SEEK_STEP_SEC : -SEEK_STEP_SEC;
        setSeekPreviewSec(Math.max(0, Math.min(dur, Math.round(base + delta))));
        return true;
      }
      if (action === 'select') {
        if (seekPreviewSec() !== null) {
          commitPreview();
          return true;
        }
        return false;
      }
      if (action === 'back' && seekPreviewSec() !== null) {
        setSeekPreviewSec(null);
        return true;
      }
      return false;
    });

    const unregisterBack = focus.registerBackHandler(() => {
      if (seekPreviewSec() !== null) {
        setSeekPreviewSec(null);
        return true;
      }
      return false;
    });

    onCleanup(() => {
      unregisterInterceptor();
      unregisterBack();
    });
  });

  return (
    <Show
      when={track()}
      fallback={
        <section
          class={styles.tvEmptyPanel}
          data-tv-group-container="np-empty"
          data-tv-group-kind="row"
          data-tv-group-order="10"
        >
          <h1 class={styles.tvPageTitle}>{t('tv.player.nothingPlaying')}</h1>
          <p class={styles.tvSubtitle}>{t('tv.player.nothingHint')}</p>
          <Control
            data-tv-id="np-empty-home"
            data-tv-group="np-empty"
            data-tv-index="0"
            data-tv-focused={focus.activeId() === 'np-empty-home' ? 'true' : undefined}
            class={styles.tvPrimaryBtn}
            classList={{ [styles.tvFocusTarget]: true }}
            onClick={props.onNavigateHome}
          >
            {t('tv.nav.home')}
          </Control>
        </section>
      }
    >
      {(current) => (
        <div class={styles.tvNowPlaying}>
          <Show when={state.playback.needsGesture}>
            <div
              class={styles.tvGestureBanner}
              data-tv-group-container="np-gesture"
              data-tv-group-kind="row"
              data-tv-group-order="5"
              role="alert"
            >
              <span>{t('tv.player.pressOkToPlay')}</span>
              <Control
                data-tv-id="np-gesture-btn"
                data-tv-group="np-gesture"
                data-tv-index="0"
                data-tv-focused={focus.activeId() === 'np-gesture-btn' ? 'true' : undefined}
                class={styles.tvPrimaryBtn}
                classList={{ [styles.tvFocusTarget]: true }}
                onClick={() => actions.resumePlayback()}
              >
                {t('tv.resume')}
              </Control>
            </div>
          </Show>

          <section class={styles.tvNowStage}>
            <TvArtwork
              class={styles.tvNowArt}
              src={trackCoverUrl(current())}
              alt={current().title}
              fallbackLabel={current().title}
            />
            <div class={styles.tvNowMeta}>
              <span class={styles.tvEyebrow}>{t('tv.nav.nowPlaying')}</span>
              <h1 class={styles.tvHeroTitle}>{current().title}</h1>
              <p class={styles.tvPageTitle}>{current().artist}</p>
              <Show when={current().album}>
                <p class={styles.tvSubtitle}>{current().album}</p>
              </Show>
            </div>
          </section>

          <div
            class={styles.tvSeekBox}
            data-tv-group-container="np-seek-group"
            data-tv-group-kind="row"
            data-tv-group-order="15"
            data-tv-rail-edge="none"
          >
            <Control
              role="slider"
              aria-label={t('tv.player.seekLabel')}
              aria-valuemin={0}
              aria-valuemax={Math.round(durationSec())}
              aria-valuenow={Math.round(displayedPositionSec())}
              data-tv-id="np-seek"
              data-tv-group="np-seek-group"
              data-tv-index="0"
              data-tv-focused={focus.activeId() === 'np-seek' ? 'true' : undefined}
              class={styles.tvSeekControl}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={() => {
                if (seekPreviewSec() !== null) {
                  commitPreview();
                } else {
                  setSeekPreviewSec(Math.round(state.playback.currentTime));
                }
              }}
            >
              <div class={styles.tvSeekTrack}>
                <div class={styles.tvSeekFill} style={{ width: progressPct() }} />
              </div>
              <div class={styles.tvSeekTimes}>
                <span>
                  {seekPreviewSec() !== null
                    ? t('tv.player.seekPreview', { time: clockTime(seekPreviewSec()!) })
                    : clockTime(state.playback.currentTime)}
                </span>
                <span>{t('tv.player.seekHint')}</span>
                <span>{clockTime(durationSec())}</span>
              </div>
            </Control>
          </div>

          <div
            class={styles.tvRowGroup}
            data-tv-group-container="np-transport"
            data-tv-group-kind="row"
            data-tv-group-order="25"
          >
            <Control
              data-tv-id="np-prev"
              data-tv-group="np-transport"
              data-tv-index="0"
              data-tv-focused={focus.activeId() === 'np-prev' ? 'true' : undefined}
              class={styles.tvSecondaryBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={() => actions.prev()}
            >
              <PrevFilledIcon /> {t('tv.previous')}
            </Control>
            <Control
              data-tv-id="np-toggle"
              data-tv-group="np-transport"
              data-tv-index="1"
              data-tv-focused={focus.activeId() === 'np-toggle' ? 'true' : undefined}
              class={styles.tvPrimaryBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={() => actions.togglePlay()}
            >
              {state.playback.isPlaying ? <PauseFilledIcon /> : <PlayFilledIcon />}
              {state.playback.isPlaying ? t('tv.pause') : t('tv.play')}
            </Control>
            <Control
              data-tv-id="np-next"
              data-tv-group="np-transport"
              data-tv-index="2"
              data-tv-focused={focus.activeId() === 'np-next' ? 'true' : undefined}
              class={styles.tvSecondaryBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={() => actions.next()}
            >
              <NextFilledIcon /> {t('tv.next')}
            </Control>
            <Control
              data-tv-id="np-queue"
              data-tv-group="np-transport"
              data-tv-index="3"
              data-tv-focused={focus.activeId() === 'np-queue' ? 'true' : undefined}
              class={styles.tvSecondaryBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={() => setQueueOpen(true)}
            >
              <QueueListIcon /> {t('tv.queue')} ({state.playback.queue.length})
            </Control>
            <Control
              data-tv-id="np-dim"
              data-tv-group="np-transport"
              data-tv-index="4"
              data-tv-focused={focus.activeId() === 'np-dim' ? 'true' : undefined}
              class={styles.tvSecondaryBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={() => setDimActive(true)}
            >
              ☾ {t('tv.dim')}
            </Control>
          </div>
        </div>
      )}
    </Show>
  );
}
