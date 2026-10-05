import { createEffect, createMemo, createSignal, Match, on, onCleanup, onMount, Show, Switch, untrack } from 'solid-js';
import {
  collectionStep, discographyOf, jobMissingCount, jobReviewCount, jobRunning, saveCollection,
} from '../lib/collection';
import { api } from '../lib/api';
import { confirmDialog } from '../lib/confirm';
import { formatBytes } from '../lib/format';
import { t } from '../lib/i18n';
import { migrationApi, type MigrationCandidate, type MigrationJob, type MigrationTrack } from '../lib/migrationApi';
import { openOverlay } from '../lib/overlay';
import { entitiesBusy, fillEntityCover, isEntitySaved, setEntitySaved, syncSavedEntities, type SavedEntity } from '../lib/savedEntities';
import { toast } from '../lib/toast';
import { ownedTrackForItem } from '../stores';
import type { CatalogItem } from '../types/music';
import { BookmarkIcon, CheckIcon, MoreIcon, menuIcons } from './icons';
import { Spinner } from './Spinner';
import { openActionMenu } from './ActionMenu';
import saveStyles from './SavedEntities.module.css';
import styles from './CollectionControl.module.css';
import { collectionArrivedCount as arrivedOf } from '../lib/collectionState';
import { CollectionDownloadView } from './CollectionDownloadView';

/** How often a running download is looked at again. */
const WATCH_MS = 3000;
/** What the engine assumes per second of audio when it sizes a download. */
const BYTES_PER_SECOND = 192_000 / 8;

const downloads = {
  album: { get: api.getAlbumDownload, start: api.startAlbumDownload },
  artist: { get: api.getArtistDownload, start: api.startArtistDownload },
};

/** Bookmark first; explicit bulk song actions live in the overflow menu. */
export function CollectionControl(props: { entity: SavedEntity; deezerId?: string; tracklist?: CatalogItem[]; onMenuReady?: (open: () => void) => void }) {
  onMount(() => {
    void syncSavedEntities();
    props.onMenuReady?.(openMenu);
  });
  const artist = () => props.entity.kind === 'artist';
  const saved = () => isEntitySaved(props.entity);
  // A bookmark saved without a picture takes the one this page shows, once per
  // picture: a failed write waits for the next visit instead of looping.
  let offeredCover: string | undefined;
  createEffect(() => {
    const cover = props.entity.cover;
    if (!saved() || !cover || cover === offeredCover) return;
    offeredCover = cover;
    untrack(() => void fillEntityCover(props.entity));
  });
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
      if (props.deezerId === id) {
        setJob(latest);
        // A restored download needs its full tracklist for progress and ownership.
        // A bookmark alone never fetches the artist's discography.
        if (latest && artist()) void readDiscography();
      }
    } catch {
      /* looked at again on the next change */
    }
  };
  createEffect(on(() => props.deezerId, (id) => {
    setJob(null);
    if (!id) return;
    void refresh();
  }));
  createEffect(on(() => props.deezerId, () => setDiscography(null), { defer: true }));
  let watch: number | undefined;
  createEffect(() => {
    window.clearInterval(watch);
    watch = jobRunning(job()) ? window.setInterval(() => void refresh(), WATCH_MS) : undefined;
  });
  onCleanup(() => window.clearInterval(watch));

  const step = () => collectionStep({ total: total(), owned: owned(), job: job() });
  const arrived = () => arrivedOf(job());

  const toggleSaved = async () => {
    if (changing()) return;
    setChanging(true);
    try {
      await setEntitySaved(props.entity, !saved());
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
    if (!id || starting()) return;
    setStarting(true);
    try {
      const list = await readDiscography();
      if (!list.length) {
        toast.error(t('collectionControl.failed'));
        return;
      }
      if (!(await confirmDownload())) return;
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

  const addSongs = async () => {
    if (changing()) return;
    setChanging(true);
    try {
      const list = await readDiscography();
      if (!list.length) {
        toast.error(t('collectionControl.failed'));
        return;
      }
      await saveCollection(props.entity, list);
    } finally {
      setChanging(false);
    }
  };

  const downloadName = () => artist()
    ? t('collectionControl.downloadArtist', { title: props.entity.name })
    : t('collectionControl.downloadAlbum');

  const openMenu = () => openActionMenu({
    title: props.entity.name,
    actions: [
      { icon: saved() ? menuIcons.unbookmark() : menuIcons.bookmark(),
        label: t(saved() ? 'savedEntities.remove' : 'savedEntities.save'),
        disabled: entitiesBusy() || changing(), onSelect: () => void toggleSaved() },
      ...(props.deezerId || (props.tracklist?.length ?? 0) > 0 ? [
        { icon: menuIcons.save(), label: t('collectionControl.addSongs'),
          disabled: starting() || changing(), onSelect: () => void addSongs() },
      ] : []),
      ...(props.deezerId ? [{ icon: menuIcons.download(), label: downloadName(),
        disabled: starting() || changing(), onSelect: () => void download() }] : []),
    ],
  });

  return (
    <span class={styles.control}>
      <button type="button" class={saveStyles.save} aria-pressed={saved()} aria-busy={changing() || undefined}
        disabled={entitiesBusy() || changing()} onClick={() => void toggleSaved()}>
        <BookmarkIcon />
        {saved() ? t('savedEntities.saved') : t('savedEntities.save')}
      </button>
      <button type="button" class={styles.step} aria-label={t('savedEntities.options')}
        aria-haspopup="dialog" onClick={openMenu}><MoreIcon size={18} /></button>
      <Show when={job()}>
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

  return <CollectionDownloadView title={props.title} job={props.job()} busy={busy()}
    onControl={action => void act(id => migrationApi.control(id, action))} onDecide={decide} />;
}
