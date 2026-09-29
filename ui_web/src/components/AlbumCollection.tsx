import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from 'solid-js';
import {
  albumStep, jobMissingCount, jobReviewCount, jobRunning, saveAlbum, unsaveAlbum,
} from '../lib/albumCollection';
import { api } from '../lib/api';
import { formatDuration } from '../lib/format';
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
import styles from './AlbumCollection.module.css';

/** How often a running album download is looked at again. */
const WATCH_MS = 3000;

/** Songs of the download already in the library, fetched now or held before. */
const arrivedOf = (job: MigrationJob | null) =>
  (job?.selected_counts.completed ?? 0) + (job?.selected_counts.existing ?? 0);

/**
 * The album's place in your library, as one control: saved or not, and then
 * the next step for its songs — download them, watch them arrive, choose a
 * version where the match was doubtful, or see that they are all here.
 */
export function AlbumCollection(props: { entity: SavedEntity; tracklist: CatalogItem[]; deezerId?: string }) {
  onMount(() => void syncSavedEntities());
  const saved = () => isEntitySaved(props.entity);
  const total = () => props.tracklist.length;
  const owned = createMemo(() => props.tracklist.filter((item) => ownedTrackForItem(item)).length);
  const [job, setJob] = createSignal<MigrationJob | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [changing, setChanging] = createSignal(false);

  const refresh = async () => {
    const id = props.deezerId;
    if (!id) return;
    try {
      const { job: latest } = await api.getAlbumDownload(id);
      if (props.deezerId === id) setJob(latest);
    } catch {
      /* looked at again on the next change */
    }
  };
  createEffect(on(() => [props.deezerId, saved()] as const, ([id, isSaved]) => {
    setJob(null);
    if (id && isSaved) void refresh();
  }));
  let watch: number | undefined;
  createEffect(() => {
    window.clearInterval(watch);
    watch = jobRunning(job()) ? window.setInterval(() => void refresh(), WATCH_MS) : undefined;
  });
  onCleanup(() => window.clearInterval(watch));

  const step = () => albumStep({ saved: saved(), total: total(), owned: owned(), job: job() });
  const arrived = () => arrivedOf(job());

  const toggleSaved = async () => {
    if (changing()) return;
    setChanging(true);
    try {
      await (saved() ? unsaveAlbum(props.entity, props.tracklist) : saveAlbum(props.entity, props.tracklist));
    } finally {
      setChanging(false);
    }
  };

  const download = async () => {
    const id = props.deezerId;
    if (!id || starting()) return;
    setStarting(true);
    try {
      setJob((await api.startAlbumDownload(id)).job);
      toast.success(t('albumCollection.started', { title: props.entity.name }));
    } catch {
      toast.error(t('albumCollection.failed'));
    } finally {
      setStarting(false);
    }
  };

  const details = () => openOverlay((close) => (
    <AlbumDownloadSheet title={props.entity.name} job={job} onJob={setJob} close={close} />
  ), { ariaLabel: () => props.entity.name });

  return (
    <span class={styles.control}>
      <button type="button" class={saveStyles.save} aria-pressed={saved()}
        disabled={entitiesBusy() || changing()} onClick={() => void toggleSaved()}>
        <BookmarkIcon />
        {saved() ? t('savedEntities.saved') : t('savedEntities.save')}
      </button>
      <Show when={saved() && props.deezerId && total() > 0}>
        <Switch>
          <Match when={step() === 'owned'}>
            <span class={styles.step} data-step="owned" role="status" title={t('albumCollection.owned')}>
              <CheckIcon size={18} /><span class={styles.label}>{t('albumCollection.owned')}</span>
            </span>
          </Match>
          <Match when={step() === 'downloading'}>
            <button type="button" class={styles.step} data-step="downloading" onClick={details}
              aria-label={t('albumCollection.downloading', { done: arrived(), total: job()?.selected_track_count ?? total() })}>
              <Spinner size={18} />
              <span class={styles.label}>{arrived()}/{job()?.selected_track_count ?? total()}</span>
            </button>
          </Match>
          <Match when={step() === 'review'}>
            <button type="button" class={styles.step} data-step="review" onClick={details}>
              {t('albumCollection.review', { n: jobReviewCount(job()) })}
            </button>
          </Match>
          <Match when={step() === 'missing'}>
            <button type="button" class={styles.step} data-step="missing" onClick={details}>
              {t('albumCollection.missing', { n: jobMissingCount(job()) })}
            </button>
          </Match>
          <Match when={true}>
            <button type="button" class={styles.step} data-step="download" disabled={starting()}
              aria-label={t('albumCollection.downloadAlbum')} title={t('albumCollection.downloadAlbum')} onClick={() => void download()}>
              <DownloadIcon size={18} /><span class={styles.label}>{t('albumCollection.download')}</span>
            </button>
          </Match>
        </Switch>
      </Show>
    </span>
  );
}

/** What the download is doing, and the songs that need a hand from you. */
function AlbumDownloadSheet(props: {
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
      toast.error(t('albumCollection.failed'));
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
          {t(jobRunning(props.job()) ? 'albumCollection.downloading' : 'albumCollection.summary', {
            done: arrivedOf(props.job()), total: props.job()?.selected_track_count ?? 0,
          })}
        </span>
      </header>

      <Show when={review().length > 0}>
        <section class={styles.section} aria-label={t('albumCollection.chooseTitle')}>
          <h3 class={styles.sectionTitle}>{t('albumCollection.chooseTitle')}</h3>
          <p class={styles.hint}>{t('albumCollection.chooseHint')}</p>
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
                  {t('albumCollection.skip')}
                </button>
              </div>
            )}
          </For>
        </section>
      </Show>

      <Show when={failed().length > 0 || unfound().length > 0}>
        <section class={styles.section} aria-label={t('albumCollection.missingTitle')}>
          <h3 class={styles.sectionTitle}>{t('albumCollection.missingTitle')}</h3>
          <ul class={styles.missingList}>
            <For each={[...failed(), ...unfound()]}>
              {(row) => (
                <li>
                  <span class={styles.songTitle}>{row.source?.title}</span>
                  <span class={styles.candidateMeta}>
                    {row.state === 'failed' ? t('albumCollection.failedSong') : t('albumCollection.unfoundSong')}
                  </span>
                </li>
              )}
            </For>
          </ul>
          <Show when={failed().length > 0 && !jobRunning(props.job())}>
            <button type="button" class={styles.action} disabled={busy()}
              onClick={() => void act((id) => migrationApi.control(id, 'retry'))}>
              {t('albumCollection.retry')}
            </button>
          </Show>
        </section>
      </Show>

      <Show when={jobRunning(props.job())}>
        <button type="button" class={styles.stop} disabled={busy()}
          onClick={() => void act((id) => migrationApi.control(id, 'cancel'))}>
          {t('albumCollection.stop')}
        </button>
      </Show>
    </div>
  );
}
