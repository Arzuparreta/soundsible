import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { ApiError } from '../lib/api';
import {
  migrationApi,
  type MigrationCandidate,
  type MigrationJob,
  type MigrationTrack,
} from '../lib/migrationApi';
import { migrateCopy } from '../lib/migrateCopy';
import { ViewHeader } from '../components/ViewHeader';
import Button from '../components/Button';
import { toast } from '../lib/toast';
import { copyText } from '../lib/clipboard';
import styles from './Migrate.module.css';

const ACTIVE_STATES = new Set(['queued', 'running']);
const RESTORABLE_STATES = new Set([
  'analyzed',
  'queued',
  'running',
  'paused',
  'needs_review',
  'partial',
  'failed',
]);

type MigrationProvider = 'spotify' | 'apple';
type AppleDevice = 'mac' | 'windows' | 'mobile';

interface MigrationGuideState {
  provider: MigrationProvider | null;
  spotifyWaiting: boolean;
}

const GUIDE_STATE_KEY = 'soundsible.migration-guide';
const SPOTIFY_PRIVACY_URL = 'https://www.spotify.com/account/privacy/';
const SPOTIFY_DATA_HELP_URL = 'https://support.spotify.com/article/understanding-your-data/';
const APPLE_MAC_HELP_URL =
  'https://support.apple.com/guide/music/save-a-copy-of-a-playlist-mus27cd5060f/mac';
const APPLE_WINDOWS_HELP_URL =
  'https://support.apple.com/guide/itunes/save-a-copy-of-your-playlists-itns2998/windows';

function readGuideState(): MigrationGuideState {
  try {
    const saved = JSON.parse(localStorage.getItem(GUIDE_STATE_KEY) ?? '{}') as Partial<MigrationGuideState>;
    return {
      provider: saved.provider === 'spotify' || saved.provider === 'apple' ? saved.provider : null,
      spotifyWaiting: saved.spotifyWaiting === true,
    };
  } catch {
    return { provider: null, spotifyWaiting: false };
  }
}

function writeGuideState(state: MigrationGuideState): void {
  try {
    localStorage.setItem(GUIDE_STATE_KEY, JSON.stringify(state));
  } catch {
    // The guide remains fully usable when browser storage is unavailable.
  }
}

function clearGuideState(): void {
  try {
    localStorage.removeItem(GUIDE_STATE_KEY);
  } catch {
    // Nothing else depends on this optional convenience state.
  }
}

function detectAppleDevice(): AppleDevice {
  const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (/iphone|ipad|ipod|android/.test(platform)) return 'mobile';
  if (platform.includes('win')) return 'windows';
  return 'mac';
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

export default function Migrate() {
  const navigate = useNavigate();
  const c = createMemo(migrateCopy);
  const [job, setJob] = createSignal<MigrationJob | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [restoring, setRestoring] = createSignal(true);
  const [dragging, setDragging] = createSignal(false);
  const [includeLibrary, setIncludeLibrary] = createSignal(true);
  const [playlistIds, setPlaylistIds] = createSignal<Set<string>>(new Set());

  const adoptJob = (next: MigrationJob) => {
    setJob(next);
    setIncludeLibrary(next.selection.include_library ?? true);
    const saved = next.selection.playlist_ids;
    setPlaylistIds(
      new Set(
        saved ??
          next.manifest.playlists
            .filter((playlist) => !playlist.is_favourites)
            .map((playlist) => playlist.source_id),
      ),
    );
  };

  onMount(async () => {
    try {
      const { jobs } = await migrationApi.list();
      const unfinished = jobs.find((candidate) => RESTORABLE_STATES.has(candidate.state));
      if (unfinished) {
        const { job: detailed } = await migrationApi.get(unfinished.id);
        adoptJob(detailed);
      }
    } catch {
      // Import stays usable if restoring an old job fails.
    } finally {
      setRestoring(false);
    }
  });

  createEffect(() => {
    const current = job();
    if (!current || !ACTIVE_STATES.has(current.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const { job: updated } = await migrationApi.get(current.id);
        adoptJob(updated);
      } catch {
        // A transient polling failure must not discard visible progress.
      }
    }, 1200);
    onCleanup(() => window.clearInterval(timer));
  });

  const analyze = async (file: File | undefined) => {
    if (!file || busy()) return;
    setBusy(true);
    try {
      const { job: analyzed } = await migrationApi.upload(file);
      clearGuideState();
      adoptJob(analyzed);
    } catch (error) {
      toast.error(error instanceof ApiError ? c().badFile : c().failed);
    } finally {
      setBusy(false);
      setDragging(false);
    }
  };

  const togglePlaylist = (id: string) => {
    setPlaylistIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedTrackCount = createMemo(() => {
    const current = job();
    if (!current) return 0;
    const keys = new Set<string>();
    if (includeLibrary()) {
      const libraryKeys = new Set(
        current.manifest.playlists
          .filter((playlist) => playlist.is_favourites)
          .flatMap((playlist) => playlist.track_keys),
      );
      if (libraryKeys.size > 0) libraryKeys.forEach((key) => keys.add(key));
      else (current.tracks ?? []).forEach((track) => keys.add(track.source_key));
    }
    for (const playlist of current.manifest.playlists) {
      if (!playlistIds().has(playlist.source_id)) continue;
      playlist.track_keys.forEach((key) => keys.add(key));
    }
    return Math.min(current.manifest.track_count, keys.size);
  });

  const start = async () => {
    const current = job();
    if (!current || (!includeLibrary() && playlistIds().size === 0)) return;
    setBusy(true);
    try {
      const response = await migrationApi.start(current.id, {
        include_library: includeLibrary(),
        playlist_ids: [...playlistIds()],
      });
      adoptJob(response.job);
    } catch {
      toast.error(c().failed);
    } finally {
      setBusy(false);
    }
  };

  const control = async (action: 'pause' | 'resume' | 'cancel' | 'retry') => {
    const current = job();
    if (!current || busy()) return;
    setBusy(true);
    try {
      const response = await migrationApi.control(current.id, action);
      adoptJob(response.job);
      if (action === 'cancel') setJob(null);
    } catch {
      toast.error(c().failed);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (track: MigrationTrack, candidate?: MigrationCandidate) => {
    const current = job();
    if (!current || busy()) return;
    setBusy(true);
    try {
      const payload = candidate
        ? candidate.kind === 'library' && candidate.track_id
          ? {
              source_key: track.source_key,
              decision: 'use_library_track' as const,
              track_id: candidate.track_id,
            }
          : {
              source_key: track.source_key,
              decision: 'use_candidate' as const,
              candidate,
            }
        : { source_key: track.source_key, decision: 'skip' as const };
      const response = await migrationApi.decide(current.id, payload);
      adoptJob(response.job);
    } catch {
      toast.error(c().failed);
    } finally {
      setBusy(false);
    }
  };

  const reviewTracks = createMemo(
    () => job()?.tracks?.filter((track) => track.state === 'needs_review') ?? [],
  );
  const processed = createMemo(() => {
    const counts = job()?.selected_counts ?? {};
    return (
      (counts.existing ?? 0) +
      (counts.completed ?? 0) +
      (counts.needs_review ?? 0) +
      (counts.skipped ?? 0) +
      (counts.unavailable ?? 0) +
      (counts.failed ?? 0)
    );
  });
  const ready = createMemo(
    () => (job()?.selected_counts.existing ?? 0) + (job()?.selected_counts.completed ?? 0),
  );
  const progress = createMemo(() =>
    job()?.selected_track_count
      ? Math.min(100, Math.round((processed() / job()!.selected_track_count) * 100))
      : 0,
  );
  const resetImport = () => {
    clearGuideState();
    setJob(null);
  };

  return (
    <div class="view">
      <ViewHeader title={c().title} />
      <div class={styles.scroll} data-primary-scroll>
        <Show when={!restoring()} fallback={<StatusCard label={c().recent} />}>
          <Show when={job()} fallback={<UploadStep busy={busy()} dragging={dragging()} setDragging={setDragging} analyze={analyze} />}>
            {(current) => (
              <Show
                when={current().state !== 'analyzed'}
                fallback={
                  <SelectionStep
                    job={current()}
                    includeLibrary={includeLibrary()}
                    playlistIds={playlistIds()}
                    busy={busy()}
                    selectedCount={selectedTrackCount()}
                    onIncludeLibrary={setIncludeLibrary}
                    onTogglePlaylist={togglePlaylist}
                    onAll={() =>
                      setPlaylistIds(
                        new Set(
                          current()
                            .manifest.playlists.filter((playlist) => !playlist.is_favourites)
                            .map((playlist) => playlist.source_id),
                        ),
                      )
                    }
                    onClear={() => setPlaylistIds(new Set())}
                    onStart={start}
                    onReset={resetImport}
                  />
                }
              >
                <JobStep
                  job={current()}
                  busy={busy()}
                  ready={ready()}
                  progress={progress()}
                  reviewTracks={reviewTracks()}
                  onControl={control}
                  onDecide={decide}
                  onReset={resetImport}
                  onOpen={() => navigate('/playlists')}
                />
              </Show>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}

function UploadStep(props: {
  busy: boolean;
  dragging: boolean;
  setDragging: (value: boolean) => void;
  analyze: (file: File | undefined) => void;
}) {
  const c = createMemo(migrateCopy);
  const saved = readGuideState();
  const [provider, setProvider] = createSignal<MigrationProvider | null>(saved.provider);
  const [spotifyWaiting, setSpotifyWaiting] = createSignal(saved.spotifyWaiting);
  const [appleDevice, setAppleDevice] = createSignal<AppleDevice>(detectAppleDevice());

  const chooseProvider = (next: MigrationProvider | null) => {
    setProvider(next);
    if (!next) setSpotifyWaiting(false);
    writeGuideState({ provider: next, spotifyWaiting: next === 'spotify' && spotifyWaiting() });
  };

  const markSpotifyRequested = () => {
    setSpotifyWaiting(true);
    writeGuideState({ provider: 'spotify', spotifyWaiting: true });
  };

  const copyStationAddress = async () => {
    if (await copyText(window.location.href)) toast.success(c().addressCopied);
    else toast.error(c().copyFailed);
  };

  return (
    <>
      <section class={styles.hero}>
        <span class={styles.eyebrow}>{c().eyebrow}</span>
        <h1>{c().title}</h1>
        <p>{c().intro}</p>
      </section>
      <Show
        when={provider()}
        fallback={
          <section class={styles.providerPicker} aria-labelledby="migration-source-title">
            <div class={styles.guideHeading}>
              <h2 id="migration-source-title">{c().chooseSource}</h2>
              <p>{c().chooseSourceHint}</p>
            </div>
            <div class={styles.providerGrid}>
              <button class={styles.providerCard} type="button" onClick={() => chooseProvider('spotify')}>
                <span class={`${styles.providerMark} ${styles.spotifyMark}`} aria-hidden="true">●</span>
                <span>
                  <strong>Spotify</strong>
                  <small>{c().spotifySummary}</small>
                </span>
                <span class={styles.providerArrow} aria-hidden="true">→</span>
              </button>
              <button class={styles.providerCard} type="button" onClick={() => chooseProvider('apple')}>
                <span class={`${styles.providerMark} ${styles.appleMark}`} aria-hidden="true">♪</span>
                <span>
                  <strong>Apple Music</strong>
                  <small>{c().appleSummary}</small>
                </span>
                <span class={styles.providerArrow} aria-hidden="true">→</span>
              </button>
            </div>
          </section>
        }
      >
        {(selected) => (
          <section class={styles.guide}>
            <button class={styles.back} type="button" onClick={() => chooseProvider(null)}>
              ← {c().back}
            </button>
            <div class={styles.guideHeading}>
              <span class={styles.provider}>{selected() === 'spotify' ? 'Spotify' : 'Apple Music'}</span>
              <h2>
                {selected() === 'spotify'
                  ? spotifyWaiting()
                    ? c().spotifyWaitingTitle
                    : c().spotifyTitle
                  : c().appleTitle}
              </h2>
              <p>
                {selected() === 'spotify'
                  ? spotifyWaiting()
                    ? c().spotifyWaitingIntro
                    : c().spotifyIntro
                  : c().appleIntro}
              </p>
            </div>

            <Show when={selected() === 'spotify'}>
              <ol class={styles.steps}>
                <li class={styles.step}>
                  <span class={styles.stepNumber}>1</span>
                  <span>
                    <strong>{c().spotifyRequestTitle}</strong>
                    <small>{c().spotifyRequestDetail}</small>
                    <a
                      class={styles.externalButton}
                      href={SPOTIFY_PRIVACY_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={markSpotifyRequested}
                    >
                      {c().openSpotify} ↗
                    </a>
                  </span>
                </li>
                <li class={styles.step}>
                  <span class={styles.stepNumber}>2</span>
                  <span>
                    <strong>{c().spotifyWaitTitle}</strong>
                    <small>{c().spotifyWaitDetail}</small>
                  </span>
                </li>
                <li class={styles.step}>
                  <span class={styles.stepNumber}>3</span>
                  <span>
                    <strong>{c().spotifyReturnTitle}</strong>
                    <small>{c().spotifyReturnDetail}</small>
                  </span>
                </li>
              </ol>
              <a
                class={styles.supportLink}
                href={SPOTIFY_DATA_HELP_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {c().officialInstructions} ↗
              </a>
            </Show>

            <Show when={selected() === 'apple'}>
              <div class={styles.deviceTabs} role="group" aria-label={c().appleDeviceLabel}>
                <button
                  type="button"
                  aria-pressed={appleDevice() === 'mac'}
                  classList={{ [styles.deviceActive]: appleDevice() === 'mac' }}
                  onClick={() => setAppleDevice('mac')}
                >
                  Mac
                </button>
                <button
                  type="button"
                  aria-pressed={appleDevice() === 'windows'}
                  classList={{ [styles.deviceActive]: appleDevice() === 'windows' }}
                  onClick={() => setAppleDevice('windows')}
                >
                  Windows
                </button>
                <button
                  type="button"
                  aria-pressed={appleDevice() === 'mobile'}
                  classList={{ [styles.deviceActive]: appleDevice() === 'mobile' }}
                  onClick={() => setAppleDevice('mobile')}
                >
                  {c().mobile}
                </button>
              </div>

              <Show when={appleDevice() === 'mac'}>
                <ol class={styles.steps}>
                  <GuideStep number="1" title={c().appleOpenMusic} detail={c().appleOpenMusicMacDetail} />
                  <GuideStep number="2" title={c().appleExportTitle} detail={c().appleExportMacDetail} />
                  <GuideStep number="3" title={c().appleSaveTitle} detail={c().appleSaveDetail} />
                </ol>
                <a class={styles.supportLink} href={APPLE_MAC_HELP_URL} target="_blank" rel="noopener noreferrer">
                  {c().officialInstructions} ↗
                </a>
              </Show>

              <Show when={appleDevice() === 'windows'}>
                <ol class={styles.steps}>
                  <GuideStep number="1" title={c().appleOpenItunes} detail={c().appleOpenItunesDetail} />
                  <GuideStep number="2" title={c().appleExportTitle} detail={c().appleExportWindowsDetail} />
                  <GuideStep number="3" title={c().appleSaveTitle} detail={c().appleSaveDetail} />
                </ol>
                <p class={styles.notice}>{c().appleWindowsNotice}</p>
                <a class={styles.supportLink} href={APPLE_WINDOWS_HELP_URL} target="_blank" rel="noopener noreferrer">
                  {c().officialInstructions} ↗
                </a>
              </Show>

              <Show when={appleDevice() === 'mobile'}>
                <div class={styles.mobileHandoff}>
                  <strong>{c().continueComputer}</strong>
                  <p>{c().continueComputerDetail}</p>
                  <div class={styles.addressRow}>
                    <code>{window.location.href}</code>
                    <Button variant="secondary" size="sm" onClick={copyStationAddress}>
                      {c().copyAddress}
                    </Button>
                  </div>
                </div>
              </Show>
            </Show>

            <Show when={selected() === 'spotify' || appleDevice() !== 'mobile'}>
              <label
                class={styles.drop}
                classList={{ [styles.dropActive]: props.dragging }}
                onDragEnter={(event) => {
                  event.preventDefault();
                  props.setDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => props.setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  props.analyze(event.dataTransfer?.files?.[0]);
                }}
              >
                <input
                  class={styles.fileInput}
                  type="file"
                  accept=".zip,.json,.xml,.plist,.txt,.csv,application/zip,application/json,text/xml,text/csv,text/plain"
                  onChange={(event) => props.analyze(event.currentTarget.files?.[0])}
                />
                <span class={styles.uploadMark}>↓</span>
                <strong>
                  {props.busy
                    ? c().analyzing
                    : selected() === 'spotify'
                      ? c().chooseSpotifyFile
                      : c().chooseAppleFile}
                </strong>
                <span>{c().fileHint}</span>
              </label>
            </Show>
          </section>
        )}
      </Show>
      <p class={styles.privacy}>{c().privacy}</p>
    </>
  );
}

function GuideStep(props: { number: string; title: string; detail: string }) {
  return (
    <li class={styles.step}>
      <span class={styles.stepNumber}>{props.number}</span>
      <span>
        <strong>{props.title}</strong>
        <small>{props.detail}</small>
      </span>
    </li>
  );
}

function SelectionStep(props: {
  job: MigrationJob;
  includeLibrary: boolean;
  playlistIds: Set<string>;
  busy: boolean;
  selectedCount: number;
  onIncludeLibrary: (value: boolean) => void;
  onTogglePlaylist: (id: string) => void;
  onAll: () => void;
  onClear: () => void;
  onStart: () => void;
  onReset: () => void;
}) {
  const c = createMemo(migrateCopy);
  const reusable = () => props.job.counts.existing ?? 0;
  const review = () => props.job.counts.needs_review ?? 0;
  const missing = () => props.job.counts.pending ?? 0;
  return (
    <>
      <section class={styles.hero}>
        <span class={styles.eyebrow}>{props.job.provider === 'spotify' ? 'Spotify' : 'Apple Music'}</span>
        <h1>{c().analyzed}</h1>
        <p>{c().found(props.job.manifest.track_count, props.job.manifest.playlists.length)}</p>
        <div class={styles.chips}>
          <span>{c().reuse(reusable())}</span>
          <span>{c().download(missing())}</span>
          <Show when={review()}><span class={styles.warn}>{c().review(review())}</span></Show>
        </div>
      </section>

      <section class={styles.card}>
        <ChoiceRow
          checked={props.includeLibrary}
          title={c().library}
          detail={c().libraryHint}
          count={props.job.manifest.library_count}
          onChange={() => props.onIncludeLibrary(!props.includeLibrary)}
        />
        <Show when={props.job.manifest.favourite_count > 0}>
          <p class={styles.favouriteNote}>♥ {c().favourites(props.job.manifest.favourite_count)}</p>
        </Show>
      </section>

      <Show when={props.job.manifest.playlists.some((playlist) => !playlist.is_favourites)}>
        <section class={styles.card}>
          <div class={styles.sectionHead}>
            <h2>{c().playlists}</h2>
            <div>
              <button type="button" onClick={props.onAll}>{c().selectAll}</button>
              <button type="button" onClick={props.onClear}>{c().clear}</button>
            </div>
          </div>
          <div class={styles.choices}>
            <For each={props.job.manifest.playlists.filter((playlist) => !playlist.is_favourites)}>
              {(playlist) => (
                <ChoiceRow
                  checked={props.playlistIds.has(playlist.source_id)}
                  title={playlist.name}
                  detail=""
                  count={playlist.track_count}
                  onChange={() => props.onTogglePlaylist(playlist.source_id)}
                />
              )}
            </For>
          </div>
        </section>
      </Show>

      <div class={styles.summaryBar}>
        <div>
          <strong>{c().selected(props.selectedCount)}</strong>
          <span>{c().storage(formatBytes(props.job.estimated_download_bytes))}</span>
        </div>
        <div class={styles.actions}>
          <Button variant="ghost" onClick={props.onReset}>{c().another}</Button>
          <Button
            disabled={props.busy || (!props.includeLibrary && props.playlistIds.size === 0)}
            onClick={props.onStart}
          >
            {c().start}
          </Button>
        </div>
      </div>
    </>
  );
}

function ChoiceRow(props: {
  checked: boolean;
  title: string;
  detail: string;
  count: number;
  onChange: () => void;
}) {
  return (
    <label class={styles.choice}>
      <input type="checkbox" checked={props.checked} onChange={props.onChange} />
      <span>
        <strong>{props.title}</strong>
        <Show when={props.detail}><small>{props.detail}</small></Show>
      </span>
      <em>{props.count}</em>
    </label>
  );
}

function JobStep(props: {
  job: MigrationJob;
  busy: boolean;
  ready: number;
  progress: number;
  reviewTracks: MigrationTrack[];
  onControl: (action: 'pause' | 'resume' | 'cancel' | 'retry') => void;
  onDecide: (track: MigrationTrack, candidate?: MigrationCandidate) => void;
  onReset: () => void;
  onOpen: () => void;
}) {
  const c = createMemo(migrateCopy);
  const finished = () => props.job.state === 'completed' || props.job.state === 'partial';
  return (
    <>
      <section class={styles.progressCard}>
        <span class={styles.provider}>{props.job.provider === 'spotify' ? 'Spotify' : 'Apple Music'}</span>
        <h1>
          {props.job.state === 'completed'
            ? c().done
            : props.job.state === 'partial'
              ? c().partial
              : props.job.state === 'needs_review'
                ? c().reviewTitle
                : c().moving}
        </h1>
        <p>
          {props.job.state === 'completed'
            ? c().doneHint
            : props.job.state === 'partial'
              ? c().partialHint
              : props.job.state === 'failed'
                ? props.job.error || c().failed
                : c().completed(props.ready, props.job.selected_track_count)}
        </p>
        <Show when={!finished()}>
          <div
            class={styles.progress}
            role="progressbar"
            aria-valuenow={props.progress}
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span style={{ width: `${props.progress}%` }} />
          </div>
        </Show>
        <div class={styles.actions}>
          <Show when={props.job.state === 'running' || props.job.state === 'queued'}>
            <Button variant="secondary" disabled={props.busy} onClick={() => props.onControl('pause')}>{c().pause}</Button>
          </Show>
          <Show when={props.job.state === 'paused' || props.job.state === 'needs_review'}>
            <Button disabled={props.busy || props.reviewTracks.length > 0} onClick={() => props.onControl('resume')}>{c().resume}</Button>
          </Show>
          <Show when={props.job.state === 'partial' || props.job.state === 'failed'}>
            <Button variant="secondary" disabled={props.busy} onClick={() => props.onControl('retry')}>{c().retry}</Button>
          </Show>
          <Show when={!finished() && props.job.state !== 'cancelled'}>
            <Button variant="ghost" disabled={props.busy} onClick={() => props.onControl('cancel')}>{c().cancel}</Button>
          </Show>
          <Show when={finished()}>
            <Button variant="secondary" onClick={props.onReset}>{c().another}</Button>
            <Button onClick={props.onOpen}>{c().openLibrary}</Button>
          </Show>
        </div>
      </section>

      <Show when={props.reviewTracks.length > 0}>
        <section class={styles.reviewList}>
          <p>{c().reviewHint}</p>
          <For each={props.reviewTracks}>
            {(track) => (
              <article class={styles.reviewCard}>
                <div class={styles.sourceTrack}>
                  <strong>{track.source?.title}</strong>
                  <span>{track.source?.artist}</span>
                </div>
                <Show
                  when={track.candidates.length > 0}
                  fallback={<p class={styles.noCandidate}>{track.error || c().noCandidate}</p>}
                >
                  <For each={track.candidates}>
                    {(candidate) => (
                      <div class={styles.candidate}>
                        <Show when={candidate.thumbnail}>
                          <img src={candidate.thumbnail} alt="" />
                        </Show>
                        <span>
                          <strong>{candidate.title}</strong>
                          <small>{candidate.artist}</small>
                        </span>
                        <em>{Math.round(candidate.confidence * 100)}%</em>
                        <Button size="sm" disabled={props.busy} onClick={() => props.onDecide(track, candidate)}>
                          {c().use}
                        </Button>
                      </div>
                    )}
                  </For>
                </Show>
                <button class={styles.skip} type="button" disabled={props.busy} onClick={() => props.onDecide(track)}>
                  {c().skip}
                </button>
              </article>
            )}
          </For>
        </section>
      </Show>
    </>
  );
}

function StatusCard(props: { label: string }) {
  return <section class={styles.progressCard}><p>{props.label}</p></section>;
}
