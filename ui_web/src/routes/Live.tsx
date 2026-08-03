import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { actions, state } from '../stores';
import { user } from '../lib/session';
import {
  communityConfig,
  communityError,
  createHostSession,
  endHostSession,
  hostSession,
  initCommunity,
  joinedSession,
  joinLiveSession,
  leaveLiveSession,
  listenerState,
  liveRoomLink,
  listenerStream,
  liveMediaSecure,
  liveProgram,
  liveSessions,
  publisherConnected,
  publisherState,
  refreshLiveSessions,
  retryCommunity,
  retryHostPublisher,
  retryListening,
  startListening,
  updateHostTitle,
  type LiveDeck,
  type LiveSession,
} from '../lib/community';
import { clearLiveHandoff, liveHandoffPending, secureLiveHandoffUrl } from '../lib/liveHandoff';
import { t } from '../lib/i18n';
import { ViewHeader } from '../components/ViewHeader';
import { LiveRoomPanel } from '../components/LiveRoomPanel';
import styles from './Live.module.css';

/** How long the air stays quiet before the host card mentions it. */
const BREAK_NOTICE_SECONDS = 30;

/** Seconds the room has been silent, or null while the music is playing.
 *
 * The break is measured against the host's own clock inside the payload and
 * then advanced locally, so a listener whose clock disagrees still counts the
 * same break rather than an offset one. */
function breakElapsed(): () => number | null {
  const [seconds, setSeconds] = createSignal<number | null>(null);
  createEffect(() => {
    const program = liveProgram();
    const since = program?.transport === 'paused' ? program.paused_since : null;
    if (!program || since == null) {
      setSeconds(null);
      return;
    }
    const base = Math.max(0, Math.round((program.emitted_at - since) / 1000));
    const arrived = Date.now();
    setSeconds(base);
    const timer = window.setInterval(
      () => setSeconds(base + Math.round((Date.now() - arrived) / 1000)),
      1000,
    );
    onCleanup(() => window.clearInterval(timer));
  });
  return seconds;
}

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function DeckLine(props: { deck: LiveDeck | null | undefined; secondary?: boolean }) {
  return (
    <Show when={props.deck}>
      {(value) => (
        <div class={styles.deck} data-secondary={props.secondary ? '' : undefined}>
          <span class={styles.deckArt}>
            <Show when={value().artwork_url} fallback={<span>♪</span>}>
              <img src={value().artwork_url!} alt="" />
            </Show>
          </span>
          <span>
            <strong>{value().title}</strong>
            <small>{value().artist}</small>
          </span>
        </div>
      )}
    </Show>
  );
}

function SessionCard(props: { session: LiveSession; onJoin: () => void; own?: boolean }) {
  const status = () => (
    props.session.status === 'live' && props.session.program?.transport === 'paused'
      ? 'paused'
      : props.session.status
  );
  return (
    <button
      class={styles.card}
      type="button"
      data-own={props.own ? '' : undefined}
      disabled={props.own}
      onClick={props.onJoin}
    >
      <div class={styles.cardHead}>
        <span class={styles.avatar} style={{ background: props.session.host.avatar_color ?? undefined }}>
          {props.session.host.display_name.slice(0, 1).toUpperCase()}
        </span>
        <span>
          <strong>{props.session.title}</strong>
          <small>{props.session.host.display_name}</small>
        </span>
        <span class={styles.status} data-status={status()}>
          {t(`live.status.${status()}`)}
        </span>
      </div>
      <Show when={props.session.program?.primary} fallback={<p class={styles.waiting}>{t('live.waiting')}</p>}>
        <DeckLine deck={props.session.program?.primary} />
        <Show when={props.session.program?.secondary}>
          <div class={styles.transitionBar}>
            <span style={{ width: `${Math.round((props.session.program?.transition?.progress ?? 0) * 100)}%` }} />
          </div>
          <DeckLine deck={props.session.program?.secondary} secondary />
        </Show>
      </Show>
      <footer>
        {props.own
          ? t('live.ownRoom')
          : t('live.listeners', { count: props.session.listener_count })}
      </footer>
    </button>
  );
}

function ListenerRoom() {
  let audio: HTMLAudioElement | undefined;
  const [starting, setStarting] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const onBreak = breakElapsed();

  createEffect(() => {
    const stream = listenerStream();
    if (audio && stream) {
      audio.srcObject = stream;
      if (listenerState() === 'connected') void audio.play().catch(() => setFailed(true));
    }
    if (listenerState() === 'connected') setFailed(false);
  });

  const listen = async () => {
    setStarting(true);
    setFailed(false);
    try {
      const stream = await startListening();
      if (audio) {
        audio.srcObject = stream;
        await audio.play();
      }
    } catch {
      setFailed(true);
    } finally {
      setStarting(false);
    }
  };

  return (
    <section class={styles.room}>
      <div class={styles.roomStage}>
        <div class={styles.roomTop}>
          <button type="button" onClick={() => void leaveLiveSession()}>{t('common.back')}</button>
          <span>{joinedSession()?.host.display_name}</span>
        </div>
        <div class={styles.heroArt}>
          <Show when={liveProgram()?.primary?.artwork_url} fallback={<span>♪</span>}>
            <img src={liveProgram()!.primary!.artwork_url!} alt="" />
          </Show>
        </div>
        <div class={styles.now}>
          <span data-break={onBreak() !== null ? '' : undefined}>
            <Show
              when={onBreak() !== null}
              fallback={t(`live.status.${joinedSession()?.status ?? 'waiting'}`)}
            >
              {t('live.onBreak', { time: clock(onBreak()!) })}
            </Show>
          </span>
          <h2>{liveProgram()?.primary?.title ?? joinedSession()?.title}</h2>
          <p>{onBreak() !== null ? t('live.breakHint') : liveProgram()?.primary?.artist ?? t('live.waiting')}</p>
        </div>
        <Show when={liveProgram()?.secondary}>
          <div class={styles.blend}>
            <small>{liveProgram()?.transition?.technique?.replaceAll('_', ' ')}</small>
            <div><span style={{ width: `${Math.round((liveProgram()?.transition?.progress ?? 0) * 100)}%` }} /></div>
            <strong>{liveProgram()?.secondary?.title}</strong>
          </div>
        </Show>
        <audio ref={audio} autoplay />
        <button
          class={styles.listen}
          type="button"
          disabled={starting() || !liveProgram()?.primary}
          onClick={() => void listen()}
        >
          {listenerStream()
            ? t('live.listening')
            : starting()
              ? t('common.loading')
              : liveProgram()?.primary
                ? t('live.listen')
                : t('live.waiting')}
        </button>
        <Show when={failed() || listenerState() === 'failed'}>
          <p class={styles.error}>
            {t('live.listenFailed')}{' '}
            <button type="button" onClick={() => void retryListening().then(() => setFailed(false)).catch(() => setFailed(true))}>
              {t('common.retry')}
            </button>
          </p>
        </Show>
      </div>
      <LiveRoomPanel />
    </section>
  );
}

export default function Live() {
  const [title, setTitle] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  let refreshTimer: number | undefined;
  const hostBreak = breakElapsed();
  /** Dead air is normal between songs; it only deserves a word once it lasts. */
  const resting = () => (hostBreak() ?? 0) >= BREAK_NOTICE_SECONDS;
  const mediaSecure = liveMediaSecure();
  const secureLiveUrl = () => secureLiveHandoffUrl(communityConfig()?.secure_url);
  /** Whether this page was opened by the banner below, on the other origin. */
  const handedOver = liveHandoffPending();

  onMount(() => {
    setTitle(`Session by ${user()?.display_name ?? 'DJ'}`);
    void initCommunity();
    refreshTimer = window.setInterval(() => void refreshLiveSessions(), 10_000);
  });
  onCleanup(() => window.clearInterval(refreshTimer));

  const create = async () => {
    setCreating(true);
    try {
      await createHostSession(title());
    } catch {
      /* the actionable global status owns the error */
    } finally {
      setCreating(false);
    }
  };

  /**
   * Somebody pressed "go live" on a station that could not, and was sent here.
   *
   * That press is the decision; arriving is only the second half of it, so the
   * room opens by itself as soon as the relay is reachable. Playback is left
   * alone — the session being handed over is announced by the resume banner,
   * and starting anything here would be the thing that stops it appearing.
   */
  let handoffStarted = false;
  createEffect(() => {
    if (!handedOver || handoffStarted || !mediaSecure) return;
    if (hostSession() || !communityConfig()?.enabled || communityError()) return;
    handoffStarted = true;
    clearLiveHandoff();
    void create();
  });

  /** Leaving for the secure origin is a device handoff: a different origin is a
   * different store, a different device id, a different everything. Publishing
   * the session first is what the page over there will be looking for. */
  const handOver = () => actions.publishSession();

  const join = (session: LiveSession) => {
    if (state.playback.isPlaying) actions.togglePlay();
    joinLiveSession(session);
  };

  /** Hand out the public hub address: a listener needs no station of their own. */
  const share = async (sessionId: string) => {
    const link = liveRoomLink(sessionId);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt(t('live.share'), link);
    }
  };

  const retryIssue = async () => {
    const issue = communityError();
    if (issue === 'publish_failed') {
      await retryHostPublisher();
    } else if (issue === 'listen_failed') {
      await retryListening();
    } else {
      await retryCommunity();
    }
  };

  return (
    <div class={styles.page}>
      <Show when={!joinedSession()} fallback={<ListenerRoom />}>
        <ViewHeader
          title={t('live.title')}
          meta={t('live.meta')}
          actions={
            <Show
              when={hostSession()}
              fallback={
                <button
                  class={styles.goLive}
                  type="button"
                  disabled={!mediaSecure || creating() || communityError() === 'loading' || !communityConfig()?.enabled}
                  onClick={() => void create()}
                >
                  {creating() ? t('common.loading') : t('live.goLive')}
                </button>
              }
            >
              {(session) => (
                <>
                  <button class={styles.share} type="button" onClick={() => void share(session().id)}>
                    {copied() ? t('live.linkCopied') : t('live.share')}
                  </button>
                  <button class={styles.endLive} type="button" onClick={() => void endHostSession()}>
                    {t('live.end')}
                  </button>
                </>
              )}
            </Show>
          }
        />

        <Show when={!mediaSecure}>
          <div class={styles.banner} data-state="secure_context">
            <span>{t('live.service.secure_context')}</span>
            <Show
              when={secureLiveUrl()}
              fallback={
                // No secure address to offer: give the one command that makes one.
                <code class={styles.secureHint}>tailscale serve --bg --yes 5005</code>
              }
            >
              {(url) => <a href={url()} onClick={handOver}>{t('live.openSecure')}</a>}
            </Show>
          </div>
        </Show>

        <Show when={mediaSecure && communityError()}>
          {(issue) => (
            <div class={styles.banner} data-state={issue()}>
              <span>{t(`live.service.${issue()}`)}</span>
              <Show when={issue() !== 'loading' && issue() !== 'disabled' && issue() !== 'invalid' && issue() !== 'graph_lost'}>
                <button type="button" onClick={() => void retryIssue().catch(() => {})}>{t('common.retry')}</button>
              </Show>
            </div>
          )}
        </Show>

        <Show when={hostSession()}>
          {(session) => (
            <section class={styles.hostCard}>
              <div>
                <span class={styles.onAir} data-state={publisherState()}>
                  {publisherConnected()
                    ? t('live.onAir')
                    : publisherState() === 'recovering'
                      ? t('live.reconnectingAudio')
                      : publisherState() === 'failed'
                        ? t('live.publishFailed')
                        : publisherState() === 'connecting'
                          ? t('live.connectingAudio')
                          : t('live.waiting')}
                </span>
                <Show
                  when={editing()}
                  fallback={<h2 onDblClick={() => setEditing(true)}>{session().title}</h2>}
                >
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    void updateHostTitle(title()).then(() => setEditing(false));
                  }}>
                    <input value={title()} maxlength={96} onInput={(event) => setTitle(event.currentTarget.value)} />
                    <button type="submit">{t('common.save')}</button>
                  </form>
                </Show>
                <p data-break={publisherConnected() && resting() ? '' : undefined}>
                  {!publisherConnected()
                    ? t('live.startPlaying')
                    : resting()
                      ? t('live.hostBreak', { time: clock(hostBreak()!) })
                      : t('live.broadcasting')}
                </p>
              </div>
              <LiveRoomPanel compact />
            </section>
          )}
        </Show>

        <section class={styles.directory}>
          <div class={styles.directoryHead}>
            <h2>{t('live.directory')}</h2>
            <button type="button" onClick={() => void refreshLiveSessions()}>{t('live.refresh')}</button>
          </div>
          <Show when={liveSessions().length > 0} fallback={<p class={styles.empty}>{t('live.empty')}</p>}>
            <div class={styles.grid}>
              <For each={liveSessions()}>
                {(session) => (
                  <SessionCard
                    session={session}
                    own={session.id === hostSession()?.id}
                    onJoin={() => join(session)}
                  />
                )}
              </For>
            </div>
          </Show>
        </section>
      </Show>
    </div>
  );
}
