import { PodcastSkipIcon } from './PodcastSkipIcon';
import { isPodcastTrack } from '../lib/track';
import { ArtistLinks } from './MusicLinks';
import { playerTrackMusic } from '../lib/musicNavigation';
import { createMemo, createSignal, onCleanup, Match, Show, Switch, type JSX } from 'solid-js';
import { state, setNowPlayingOpen } from '../stores';
import { player } from '../stores/player';
import { trackCoverUrl } from '../lib/media';
import { mobileListLayout } from '../lib/listLayout';
import { OmniSeek } from './OmniSeek';
import { t } from '../lib/i18n';
import { linkFits, linkReading, mbps, trackKbps } from '../lib/linkQuality';
import { gainToVolumePosition, nudgeVolumeGain, volumePositionToGain } from '../lib/volumeScale';
import { Control } from '../design/Control';
import { connectLabel, openConnect } from './DeviceSheet';
import { OutputDeviceIcon } from './icons';
import { RadioBadge } from './RadioBadge';
import { Spinner } from './Spinner';
import styles from './OmniBar.module.css';

/** Persistent mini-player. Progress line + tap-to-expand + play/pause + next. */
export function OmniBar() {
  const current = createMemo(() => player().playback.currentTrack);
  const podcast = createMemo(() => Boolean(current() && isPodcastTrack(current()!)));
  const [swipeOffset, setSwipeOffset] = createSignal(0);
  let swipe: { id: number; x: number; y: number; captured: boolean } | null = null;
  let suppressClick = false;
  // The same breakpoint the stylesheet uses to hide the empty mobile deck.
  // Reactive, because it no longer only arms a gesture: below it the artist is
  // rendered as text rather than as a link, and a rotation has to re-render.
  const mobile = mobileListLayout;
  const isRemote = () => player().remote;
  const unreachable = () => player().unreachable;
  const resetSwipe = () => { swipe = null; setSwipeOffset(0); };
  const startSwipe: JSX.EventHandler<HTMLDivElement, PointerEvent> = event => {
    suppressClick = false;
    if (swipe || !event.isPrimary) { resetSwipe(); return; }
    if (!mobile() || event.pointerType !== 'touch' || !current() || isRemote()) return;
    swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, captured: false };
  };
  const moveSwipe: JSX.EventHandler<HTMLDivElement, PointerEvent> = event => {
    if (!swipe || event.pointerId !== swipe.id) return;
    const dx = event.clientX - swipe.x;
    const dy = Math.abs(event.clientY - swipe.y);
    if (!swipe.captured) {
      if (Math.max(Math.abs(dx), dy) < 10) return;
      if (dx >= 0 || -dx < dy * 1.5) { resetSwipe(); return; }
      swipe.captured = true;
      suppressClick = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    setSwipeOffset(Math.min(0, dx));
  };
  const endSwipe: JSX.EventHandler<HTMLDivElement, PointerEvent> = event => {
    if (!swipe || event.pointerId !== swipe.id) return;
    const dismiss = swipe.captured && swipeOffset() <= -72 && mobile();
    resetSwipe();
    if (dismiss) player().actions.dismissPlayback();
  };
  const loading = createMemo(() => player().playback.isLoading);
  const failed = createMemo(() => player().playback.loadError);
  const modeLabel = createMemo(() => player().autoMode.active ? t('autoMode.label') : t('nowPlaying.modeLabel'));
  const openLabel = createMemo(() => {
    if (isRemote() && unreachable()) return t('deviceSheet.offline', { device: player().deviceName });
    const track = current();
    if (!track && isRemote()) return t('deviceSheet.playingOnDevice', { device: player().deviceName });
    return track ? `${modeLabel()}: ${track.title} — ${track.artist}` : t('autoMode.enter');
  });
  const handleOpen = () => {
    if (isRemote() && (unreachable() || (!current() && !player().autoMode.active))) {
      openConnect();
      return;
    }
    if (current() || player().autoMode.active) setNowPlayingOpen(true);
    else player().actions.enterAutoMode();
  };
  /** What the second line says: the artist normally, the playback state when
   * there is something more urgent to report. */
  const subtitle = createMemo(() => {
    if (isRemote() && unreachable()) return t('deviceSheet.offline', { device: player().deviceName });
    if (failed()) return t('omnibar.unavailable');
    if (player().playback.needsGesture) return isRemote() ? t('deviceSheet.needsGesture', { device: player().deviceName }) : t('omnibar.needsGesture');
    if (player().playback.phase === 'starved') return t('omnibar.findingMore');
    if (player().playback.phase === 'recovering') return t('omnibar.reconnecting');
    if (player().playback.phase === 'buffering') return bufferingLine();
    if (loading()) {
      const prep = player().playback.previewPreparation;
      if (prep && (prep.state === 'pending' || prep.state === 'streamable')) {
        const pct = prep.progress == null ? null : Math.round(prep.progress * 100);
        const eta = prep.eta_seconds == null ? null : Math.max(0, Math.round(prep.eta_seconds));
        if (pct !== null && eta !== null) return t('common.preparingProgressEta', { progress: pct, eta });
        if (pct !== null) return t('common.preparingProgress', { progress: pct });
      }
      return t('omnibar.loading');
    }
    return current()?.artist ?? '';
  });
  /** "Buffering…" is true and useless. When the engine has measured the link and
   * the track plainly does not fit through it, say that instead: a listener who
   * can see 0,7 Mbps against a track that needs 1,5 knows what to do, and a
   * listener watching a spinner does not. Silent when nothing was measured —
   * "not measured" and "slow" are different answers. */
  const bufferingLine = () => {
    // The link reading is this device's.
    if (isRemote()) return t('omnibar.buffering');
    const reading = linkReading();
    const needed = trackKbps(current());
    if (reading?.kbps && needed && linkFits(reading, current()) === false) {
      return t('omnibar.bufferingSlow', { link: mbps(reading.kbps), needed: mbps(needed) });
    }
    return t('omnibar.buffering');
  };
  // While another device is controlled the pill names it where the artist was,
  // unless the second line has something more urgent to say. The desktop bar
  // names it on the device button instead.
  const deviceLine = createMemo(() => isRemote() && (mobile() || !current()) && subtitle() === (current()?.artist ?? ''));
  const audibleVolume = createMemo(() => (player().playback.muted ? 0 : player().playback.volume));
  const volumePct = createMemo(() => Math.round(gainToVolumePosition(audibleVolume()) * 100));
  /**
   * On a phone the pill is one thing you press to open the player, so nothing
   * inside it may quietly be a second destination: an artist link there took
   * taps aimed at the pill and sent them to a page nobody asked for. Telling
   * `ArtistLinks` the metadata is not linkable makes it render plain text, which
   * keeps the accessibility tree honest too — no link that does not navigate.
   * The desktop bar is wide enough to hold both, and keeps the link.
   */
  const subtitleMusic = createMemo(() => {
    const track = current();
    if (!track) return undefined;
    const music = playerTrackMusic(track);
    return mobile() ? { ...music, linkable: false } : music;
  });

  const coverBg = (): JSX.CSSProperties | undefined => {
    const c = current();
    if (!c) return undefined;
    const url = trackCoverUrl(c, 'thumb');
    return { background: `url("${url}") center / cover no-repeat, var(--bg-raised)` };
  };

  const volumeStyle = (): JSX.CSSProperties => ({ '--level': `${volumePct()}%` } as JSX.CSSProperties);

  const adjustVolumeByWheel = (e: WheelEvent) => {
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.05 : -0.05;
    player().actions.setVolume(nudgeVolumeGain(audibleVolume(), step));
  };

  return (
    <div classList={{ [styles.omni]: true, [styles.empty]: !current() && !isRemote() }} data-omni-player=""
      style={{ transform: swipeOffset() ? `translateX(${swipeOffset()}px)` : undefined }}
      onPointerDown={startSwipe} onPointerMove={moveSwipe} onPointerUp={endSwipe}
      onPointerCancel={resetSwipe}
      onLostPointerCapture={event => {
        // A child's implicit touch capture is released when the bar takes over.
        if (event.target === event.currentTarget) resetSwipe();
      }}
      ref={element => {
        const consumeSwipeClick = (event: MouseEvent) => {
          if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; }
        };
        element.addEventListener('click', consumeSwipeClick, true);
        onCleanup(() => element.removeEventListener('click', consumeSwipeClick, true));
      }}>
      <OmniSeek onClaim={resetSwipe} onOpen={handleOpen} />

      <div class={styles.openArea}><button
        class={styles.openButton}
        type="button"
        aria-label={openLabel()}
        onClick={handleOpen}
      />
        <div class={styles.cover} style={coverBg()} data-omni-cover="">
          <Show when={player().autoMode.active}>
            <span class={styles.coverModeBadge} data-omni-mode-badge="" aria-hidden="true">DJ</span>
          </Show>
        </div>
        <div class={styles.meta} data-omni-meta="">
          <span class={styles.title}>
            {current()?.title ?? (isRemote() ? t('nowPlaying.nothingPlaying') : t('autoMode.startDj'))}
          </span>
          <span classList={{ [styles.sub]: true, [styles.subAlert]: failed() || unreachable(), [styles.subRemote]: deviceLine() }}>
            <Switch fallback={subtitle()}>
              <Match when={deviceLine()}>
                <OutputDeviceIcon size={14} />
                <span class={styles.subName}>{player().deviceName}</span>
              </Match>
              <Match when={!current() && !isRemote()}>{state.online ? t('autoMode.startDjHint') : t('common.offline')}</Match>
              <Match when={current() && subtitle() === current()!.artist}><ArtistLinks music={subtitleMusic()!} /></Match>
            </Switch>
          </span>
        </div>
      </div>

      <RadioBadge class={styles.radioBadge} loadingClass={styles.radioBadgeLoading} />

      <button
        class={styles.ctrl}
        type="button"
        aria-label={failed()
          ? t('common.retry')
          : loading()
            ? t('common.cancel')
            : player().playback.isPlaying ? t('common.pause') : t('common.play')}
        aria-busy={loading() || player().pending('play')}
        data-pending={player().pending('play') || undefined}
        disabled={!current() || unreachable()}
        onClick={() => player().actions.togglePlay()}
      >
        <Switch>
          <Match when={failed()}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
            </svg>
          </Match>
          <Match when={loading()}>
            <Spinner size={20} />
          </Match>
          <Match when={player().playback.isPlaying}>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" />
            </svg>
          </Match>
          <Match when={true}>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path fill="currentColor" d="M8 5v14l11-7z" />
            </svg>
          </Match>
        </Switch>
      </button>

      <button
        class={styles.ctrl}
        type="button"
        aria-label={podcast() ? t('podcasts.skipForward') : t('common.next')}
        aria-busy={player().pending('next') || undefined}
        data-pending={player().pending('next') || undefined}
        disabled={!current() || unreachable()}
        onClick={() => podcast() ? player().actions.seekBy(15) : player().autoMode.active ? void player().actions.autoSkip() : player().actions.next()}
      >
        <Show when={podcast()} fallback={<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6h2v12h-2z" /></svg>}>
          <PodcastSkipIcon size={22} />
        </Show>
      </button>

      <Control
        class={styles.deviceBtn}
        classList={{ [styles.deviceBtnActive]: isRemote(), [styles.deviceBtnError]: isRemote() && unreachable() }}
        aria-label={connectLabel()}
        title={connectLabel()}
        data-device-trigger="omnibar"
        onClick={openConnect}
      >
        <OutputDeviceIcon size={18} />
        <Show when={isRemote()}>
          <span class={styles.deviceLabel}>{player().deviceName}</span>
        </Show>
      </Control>

      <Show when={player().can('transport.set_volume')}>
        <div class={styles.soundBlade} style={volumeStyle()} onWheel={adjustVolumeByWheel}>
          <Show when={player().can('transport.set_muted')}>
            <button
              class={styles.soundBtn}
              type="button"
              aria-label={player().playback.muted || player().playback.volume === 0 ? t('omnibar.unmute') : t('omnibar.mute')}
              aria-pressed={player().playback.muted}
              aria-busy={player().pending('mute') || undefined}
              data-pending={player().pending('mute') || undefined}
              onClick={() => player().actions.toggleMute()}
            >
              <Show
                when={!player().playback.muted && player().playback.volume > 0}
                fallback={
                  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6" />
                  </svg>
                }
              >
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
                </svg>
              </Show>
            </button>
          </Show>

          <div class={styles.soundRail}>
            <div class={styles.soundFill} />
            <input
              class={styles.soundRange}
              type="range"
              min={0}
              max={100}
              value={volumePct()}
              aria-label={t('omnibar.volume')}
              aria-valuetext={`${volumePct()}%`}
              onInput={(e) => player().actions.setVolume(volumePositionToGain(Number(e.currentTarget.value) / 100))}
            />
          </div>

          <span class={styles.soundValue} aria-hidden="true">
            {volumePct()}
          </span>
        </div>
      </Show>
    </div>
  );
}
