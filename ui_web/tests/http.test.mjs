import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchWithTimeout } from '../js/http.js';

test('aborts a status request that exceeds its timeout', async () => {
    const neverCompletes = (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
        });
    });

    await assert.rejects(
        fetchWithTimeout('http://station.test/status', {}, 5, neverCompletes),
        { name: 'AbortError' },
    );
});
