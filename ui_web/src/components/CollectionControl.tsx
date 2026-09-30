import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from 'solid-js';
import {
  collectionStep, discographyOf, jobMissingCount, jobReviewCount, jobRunning, saveCollection, unsaveCollection,
} from '../lib/collection';
import { api } from '../lib/api';
import { confirmDialog } from '../lib/confirm';
import { formatBytes, formatDuration } from '../lib/format';
import { t } from '../lib/i18n';
import { migrationApi, type MigrationCandidate, type MigrationJob, type MigrationTrack } from '../lib/migrationApi';
import { openOverlay } from '../lib/overlay';
import { createResponsiveTap } from '../lib/responsiveTap';
import { entitiesBusy, isEntitySaved, syncSavedEntities, type SavedEntity } from '../lib/savedEntities';
import { toast } from '../lib/toast';
import { ownedTrackForItem } from '../stores';
import type { CatalogItem } from '../types/music';
import { BookmarkIcon, CheckIcon, DownloadIcon } from './icons';
import { Spinner } from './Spinner';
import saveStyles from './SavedEntities.module.css';
import styles from './CollectionControl.module.css';

/** How often a running download is looked at again. */
const WATCH_MS = 3000;
/** What the engine assumes per second of audio when it sizes a download. */
const BYTES_PER_SECOND = 192_000 / 8;

/** Songs of the download already in the library, fetched now or held before. */
const arrivedOf = (job: MigrationJob | null) =>
  (job?.selected_counts.completed ?? 0) + (job?.selected_counts.existing ?? 0);

const downloads = {
  album: { get: api.getAlbumDownload, start: api.startAlbumDownload },
  artist: { get: api.getArtistDownload, start: api.startArtistDownload },
};

/**
 * An album's or an artist's place in your library, as one control: saved or
 * not, and then the next step for its songs — download them, watch them
 * arrive, choose a version where the match was doubtful, or see that they are
 * all here.
 *
 * An album page hands over its tracklist. An artist's songs are their albums,
 * singles and EPs, read once the artist is saved, or when saving it asks how
 * many there are.
 */
export function CollectionControl(props: { entity: SavedEntity; deezerId?: string; tracklist?: CatalogItem[] }) {
  onMount(() => void syncSavedEntities());
  const artist = () => props.entity.kind === 'artist';
  const saved = () => isEntitySaved(props.entity);
  const [discography, setDiscography] = createSignal<CatalogItem[] | null>(null);
  const songs = () => (artist() ? discography() ?? [] : props.tracklist ?? []);
  const total = () => songs().length;
  const owned = createMemo(() => songs().filter((item) => ownedTrackForItem(item)).length);
  const [job, setJob] = createSignal<MigrationJob | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [changing, setChanging] = createSignal(false);

  const readDiscography = async (): Promise<CatalogItem[]> => {
    const id = props.deezerId;
    if (!artist() || !id) return songs();
    const known = discography();
    if (known) return known;
    const read = await discographyOf(id);
    if (props.deezerId === id) setDiscography(read);
    return read;
  };

  const refresh = async () => {
    const id = props.deezerId;
    if (!id) return;
    try {
      const { job: latest } = await downloads[props.entity.kind].get(id);
      if (props.deezerId === id) setJob(latest);
    } catch {
      /* looked at again on the next change */
    }
  };
  createEffect(on(() => [props.deezerId, saved()] as const, ([id, isSaved]) => {
    setJob(null);
    if (!id || !isSaved) return;
    void refresh();
    if (artist()) void readDiscography();
  }));
  createEffect(on(() => props.deezerId, () => setDiscography(null), { defer: true }));
  let watch: number | undefined;
  createEffect(() => {
    window.clearInterval(watch);
    watch = jobRunning(job()) ? window.setInterval(() => void refresh(), WATCH_MS) : undefined;
  });
  onCleanup(() => window.clearInterval(watch));

  const step = () => collectionStep({ saved: saved(), total: total(), owned: owned(), job: job() });
  const arrived = () => arrivedOf(job());

  const toggleSaved = async () => {
    if (changing()) return;
    setChanging(true);
    try {
      const list = await readDiscography();
      await (saved() ? unsaveCollection(props.entity, list) : saveCollection(props.entity, list));
    } finally {
      setChanging(false);
    }
  };

  /** A whole catalogue is worth a look before it lands on the disk. */
  const confirmDownload = () => {
    if (!artist()) return Promise.resolve(true);
    const missing = songs().filter((item) => !ownedTrackForItem(item));
    const seconds = missing.reduce((sum, item) => sum + (item.duration ?? 0), 0);
    return confirmDialog({
      title: t('collectionControl.downloadArtist', { title: props.entity.name }),
      message: t('collectionControl.downloadArtistMessage', { n: missing.length, size: formatBytes(seconds * BYTES_PER_SECOND) }),
      confirmLabel: t('collectionControl.download'),
    });
  };

  const download = async () => {
    const id = props.deezerId;
    if (!id || starting() || !(await confirmDownload())) return;
    setStarting(true);
    try {
      setJob((await downloads[props.entity.kind].start(id)).job);
      toast.success(t('collectionControl.started', { title: props.entity.name }));
    } catch {
      toast.error(t('collectionControl.failed'));
    } finally {
      setStarting(false);
    }
  };

  const details = () => openOverlay((close) => (
    <CollectionDownloadSheet title={props.entity.name} job={job} onJob={setJob} close={close} />
  ), { ariaLabel: () => props.entity.name });

  const downloadName = () => artist()
    ? t('collectionControl.downloadArtist', { title: props.entity.name })
    : t('collectionControl.downloadAlbum');

  return (
    <span class={styles.control}>
      <button type="button" class={saveStyles.save} aria-pressed={saved()} aria-busy={changing() || undefined}
        disabled={entitiesBusy() || changing()} onClick={() => void toggleSaved()}>
        <BookmarkIcon />
        {saved() ? t('savedEntities.saved') : t('savedEntities.save')}
      </button>
      <Show when={saved() && props.deezerId && total() > 0}>
        <Switch>
          <Match when={step() === 'owned'}>
            <span class={styles.step} data-step="owned" role="status" title={t('collectionControl.owned')}>
              <CheckIcon size={18} /><span class={styles.label}>{t('collectionControl.owned')}</span>
            </span>
          </Match>
          <Match when={step() === 'downloading'}>
            <button type="button" class={styles.step} data-step="downloading" onClick={details}
              aria-label={t('collectionControl.downloading', { done: arrived(), total: job()?.selected_track_count ?? total() })}>
              <Spinner size={18} />
              <span class={styles.label}>{arrived()}/{job()?.selected_track_count ?? total()}</span>
            </button>
          </Match>
          <Match when={step() === 'review'}>
            <button type="button" class={styles.step} data-step="review" onClick={details}>
              {t('collectionControl.review', { n: jobReviewCount(job()) })}
            </button>
          </Match>
          <Match when={step() === 'missing'}>
            <button type="button" class={styles.step} data-step="missing" onClick={details}>
              {t('collectionControl.missing', { n: jobMissingCount(job()) })}
            </button>
          </Match>
          <Match when={true}>
            <button type="button" class={styles.step} data-step="download" disabled={starting()}
              aria-label={downloadName()} title={downloadName()} onClick={() => void download()}>
              <DownloadIcon size={18} />
              <span class={styles.label}>{artist() ? t('collectionControl.downloadAll') : t('collectionControl.download')}</span>
            </button>
          </Match>
        </Switch>
      </Show>
    </span>
  );
}

/** What the download is doing, and the songs that need a hand from you. */
function CollectionDownloadSheet(props: {
  title: string;
  job: () => MigrationJob | null;
  onJob: (job: MigrationJob) => void;
  close: () => void;
}) {
  const tracks = () => props.job()?.tracks ?? [];
  const review = () => tracks().filter((row) => row.state === 'needs_review');
  const unfound = () => tracks().filter((row) => row.state === 'unavailable');
  const failed = () => tracks().filter((row) => row.state === 'failed');
  const [busy, setBusy] = createSignal(false);

  const act = async (work: (id: string) => Promise<{ job: MigrationJob }>) => {
    const id = props.job()?.id;
    if (!id || busy()) return;
    setBusy(true);
    try {
      props.onJob((await work(id)).job);
    } catch {
      toast.error(t('collectionControl.failed'));
    } finally {
      setBusy(false);
    }
  };
  // A decision is acted on at once: a download in progress picks it up before
  // it finishes, and a stopped one is started again for it.
  const decide = (row: MigrationTrack, candidate?: MigrationCandidate) => void act(async (id) => {
    const decided = await migrationApi.decide(id, candidate
      ? { source_key: row.source_key, decision: 'use_candidate', candidate }
      : { source_key: row.source_key, decision: 'skip' });
    if (jobRunning(decided.job)) return decided;
    return migrationApi.control(id, 'resume').catch(() => decided);
  });

  return (
    <div class={styles.sheet}>
      <header class={styles.head}>
        <span class={styles.title}>{props.title}</span>
        <span class={styles.status} role="status">
          {t(jobRunning(props.job()) ? 'collectionControl.downloading' : 'collectionControl.summary', {
            done: arrivedOf(props.job()), total: props.job()?.selected_track_count ?? 0,
          })}
        </span>
      </header>

      <Show when={review().length > 0}>
        <section class={styles.section} aria-label={t('collectionControl.chooseTitle')}>
          <h3 class={styles.sectionTitle}>{t('collectionControl.chooseTitle')}</h3>
          <p class={styles.hint}>{t('collectionControl.chooseHint')}</p>
          <For each={review()}>
            {(row) => (
              <div class={styles.song}>
                <span class={styles.songTitle}>{row.source?.title}</span>
                <For each={row.candidates.filter((candidate) => candidate.video_id).slice(0, 3)}>
                  {(candidate) => {
                    const tap = createResponsiveTap({ onTap: () => decide(row, candidate) });
                    return (
                      <button type="button" class={styles.candidate} data-pressable disabled={busy()} {...tap}>
                        <span class={styles.candidateTitle}>{candidate.title}</span>
                        <span class={styles.candidateMeta}>
                          {[candidate.artist, candidate.duration ? formatDuration(candidate.duration) : ''].filter(Boolean).join(' · ')}
                        </span>
                      </button>
                    );
                  }}
                </For>
                <button type="button" class={styles.skip} disabled={busy()} onClick={() => decide(row)}>
                  {t('collectionControl.skip')}
                </button>
              </div>
            )}
          </For>
        </section>
      </Show>

      <Show when={failed().length > 0 || unfound().length > 0}>
        <section class={styles.section} aria-label={t('collectionControl.missingTitle')}>
          <h3 class={styles.sectionTitle}>{t('collectionControl.missingTitle')}</h3>
          <ul class={styles.missingList}>
            <For each={[...failed(), ...unfound()]}>
              {(row) => (
                <li>
                  <span class={styles.songTitle}>{row.source?.title}</span>
                  <span class={styles.candidateMeta}>
                    {row.state === 'failed' ? t('collectionControl.failedSong') : t('collectionControl.unfoundSong')}
                  </span>
                </li>
              )}
            </For>
          </ul>
          <Show when={failed().length > 0 && !jobRunning(props.job())}>
            <button type="button" class={styles.action} disabled={busy()}
              onClick={() => void act((id) => migrationApi.control(id, 'retry'))}>
              {t('collectionControl.retry')}
            </button>
          </Show>
        </section>
      </Show>

      <Show when={jobRunning(props.job())}>
        <button type="button" class={styles.stop} disabled={busy()}
          onClick={() => void act((id) => migrationApi.control(id, 'cancel'))}>
          {t('collectionControl.stop')}
        </button>
      </Show>
    </div>
  );
}
