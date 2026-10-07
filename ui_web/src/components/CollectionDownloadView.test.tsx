import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { setLocale } from '../lib/i18n';
import { CollectionDownloadView } from './CollectionDownloadView';
import type { MigrationJob } from '../lib/migrationApi';
afterEach(cleanup);
const job: MigrationJob = { provider: 'album:1', source_name: 'Album', manifest: { track_count: 1, library_count: 1, favourite_count: 0, playlists: [], warnings: [] }, selection: {}, playlist_names: {}, counts: {}, estimated_download_bytes: 0, id: 'collection', state: 'needs_review', selected_track_count: 1, selected_counts: { needs_review: 1 }, tracks: [
  { source_key: 'song', source: { title: 'Original', artist: 'Artist', album: 'Album' }, state: 'needs_review', confidence: 0,
    candidates: [{ title: 'Version', artist: 'Artist', video_id: 'A1111111111', confidence: 0.7 },
      { title: 'Library match', artist: 'Artist', track_id: 'held', confidence: 0.5 }] },
] };
it('sends the selected candidate or explicit skip for the original job row', () => {
  setLocale('en'); const decide = vi.fn();
  const view = render(() => <CollectionDownloadView title="Album" job={job} busy={false} onDecide={decide} onControl={vi.fn()} />);
  expect(view.queryByRole('button', { name: /Library match/ })).toBeNull();
  fireEvent.click(view.getByRole('button', { name: /Version/ }));
  expect(decide).toHaveBeenLastCalledWith(job.tracks![0], job.tracks![0].candidates[0]);
  fireEvent.click(view.getByRole('button', { name: /Skip/ }));
  expect(decide).toHaveBeenLastCalledWith(job.tracks![0]);
});
it('disables review while a request is pending and offers cancellation for running jobs', () => {
  setLocale('en'); const control = vi.fn();
  const busy = render(() => <CollectionDownloadView title="Album" job={job} busy={true} onDecide={vi.fn()} onControl={control} />);
  expect(busy.getByRole('button', { name: /Version/ })).toBeDisabled(); expect(busy.getByRole('button', { name: /Skip/ })).toBeDisabled();
  cleanup();
  const view = render(() => <CollectionDownloadView title="Album" job={{ ...job, state: 'running', tracks: [] }} busy={false} onDecide={vi.fn()} onControl={control} />);
  fireEvent.click(view.getByRole('button', { name: /Stop/ })); expect(control).toHaveBeenCalledWith('cancel');
});
