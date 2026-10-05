import { For, Show } from 'solid-js';
import { t } from '../lib/i18n';
import { formatDuration } from '../lib/format';
import { collectionArrivedCount as arrivedOf, jobRunning } from '../lib/collectionState';
import { createResponsiveTap } from '../lib/responsiveTap';
import type { MigrationCandidate, MigrationJob, MigrationTrack } from '../lib/migrationApi';
import styles from './CollectionControl.module.css';

/** Shared progress/review UI; its runtime supplies account-scoped job actions. */
export function CollectionDownloadView(props: {
  title: string; job: MigrationJob | null; busy: boolean;
  onControl: (action: 'cancel' | 'retry') => void;
  onDecide: (row: MigrationTrack, candidate?: MigrationCandidate) => void;
}) {
  const tracks = () => props.job?.tracks ?? [];
  const review = () => tracks().filter(row => row.state === 'needs_review');
  const unfound = () => tracks().filter(row => row.state === 'unavailable');
  const failed = () => tracks().filter(row => row.state === 'failed');
  return (
    <div class={styles.sheet}>
      <header class={styles.head}>
        <span class={styles.title}>{props.title}</span>
        <span class={styles.status} role="status">
          {t(jobRunning(props.job) ? 'collectionControl.downloading' : 'collectionControl.summary', {
            done: arrivedOf(props.job), total: props.job?.selected_track_count ?? 0,
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
                    const tap = createResponsiveTap({ onTap: () => props.onDecide(row, candidate) });
                    return (
                      <button type="button" class={styles.candidate} data-pressable disabled={props.busy} {...tap}>
                        <span class={styles.candidateTitle}>{candidate.title}</span>
                        <span class={styles.candidateMeta}>
                          {[candidate.artist, candidate.duration ? formatDuration(candidate.duration) : ''].filter(Boolean).join(' · ')}
                        </span>
                      </button>
                    );
                  }}
                </For>
                <button type="button" class={styles.skip} disabled={props.busy} onClick={() => props.onDecide(row)}>
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
          <Show when={failed().length > 0 && !jobRunning(props.job)}>
            <button type="button" class={styles.action} disabled={props.busy}
              onClick={() => props.onControl('retry')}>
              {t('collectionControl.retry')}
            </button>
          </Show>
        </section>
      </Show>

      <Show when={jobRunning(props.job)}>
        <button type="button" class={styles.stop} disabled={props.busy}
          onClick={() => props.onControl('cancel')}>
          {t('collectionControl.stop')}
        </button>
      </Show>
    </div>
  );
}
