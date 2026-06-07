import test from 'node:test';
import assert from 'node:assert/strict';

import { getDownloadProgressView, mergeDownloaderEvent } from '../js/downloader_state.js';

test('failed downloads retain their last real progress and error', () => {
    const view = getDownloadProgressView({
        status: 'failed',
        progress_percent: 28.6,
        error_message: 'YouTube closed the connection before the file finished downloading.',
    });

    assert.equal(view.percent, 28.6);
    assert.equal(view.percentLabel, '29%');
    assert.equal(view.phaseLabel, 'Failed at 29%');
    assert.match(view.detailLabel, /closed the connection/);
});

test('socket progress merges into the canonical queue snapshot', () => {
    const status = {
        is_processing: true,
        queue: [{ id: 'track-1', status: 'downloading', progress_percent: 5 }],
        logs: [],
    };

    const merged = mergeDownloaderEvent(status, {
        id: 'track-1',
        status: 'downloading',
        progress_percent: 42,
        speed: '2MiB/s',
    });

    assert.equal(merged.queue[0].progress_percent, 42);
    assert.equal(merged.queue[0].speed, '2MiB/s');
});

test('completed socket events remove the finished queue item', () => {
    const status = {
        is_processing: true,
        queue: [{ id: 'track-1', status: 'downloading' }],
        logs: [],
    };
    assert.deepEqual(mergeDownloaderEvent(status, { id: 'track-1', status: 'completed' }).queue, []);
});
