import type { MigrationJob } from './migrationApi';

/** The current download state, independent of the navigation bookmark. */
export type CollectionStep = 'download' | 'downloading' | 'review' | 'missing' | 'owned';

const RUNNING = new Set(['analyzed', 'queued', 'running']);

export const jobRunning = (job: MigrationJob | null | undefined): boolean => !!job && RUNNING.has(job.state);

export const jobReviewCount = (job: MigrationJob | null | undefined): number => job?.selected_counts?.needs_review ?? 0;

/** Songs the last pass could not get: no match was found, or the download failed. */
export const jobMissingCount = (job: MigrationJob | null | undefined): number =>
  (job?.selected_counts?.unavailable ?? 0) + (job?.selected_counts?.failed ?? 0);

export function collectionStep(opts: { total: number; owned: number; job: MigrationJob | null | undefined }): CollectionStep {
  if (opts.total > 0 && opts.owned >= opts.total) return 'owned';
  if (jobRunning(opts.job)) return 'downloading';
  if (jobReviewCount(opts.job) > 0) return 'review';
  // A song that failed is fetched again by ⬇; one never found is not.
  const unfound = opts.job?.selected_counts?.unavailable ?? 0;
  if (unfound > 0 && opts.total - opts.owned <= unfound) return 'missing';
  return 'download';
}

export const collectionArrivedCount = (job: MigrationJob | null | undefined) => (job?.selected_counts?.completed ?? 0) + (job?.selected_counts?.existing ?? 0);
