import { expect, test } from '@playwright/test';

for (const scenario of ['recovery', 'cancel', 'failure'] as const) {
  test(`durable downloads: ${scenario}`, async ({ page }) => {
    let queue = [{ id: 'job', status: 'pending', display_title: 'Recovered song' }];
    let requested = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/player/download-recovery-test', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Download recovery</title>',
    }));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/downloader/queue/status') {
        return route.fulfill({ json: { queue, is_processing: false, logs: [] } });
      }
      if (path === '/api/downloader/queue/job') {
        requested = true;
        await held;
        if (scenario === 'failure') return route.fulfill({ status: 503, json: { error: 'Storage unavailable' } });
        queue = [];
        return route.fulfill({ json: { status: 'removed' } });
      }
      await route.fulfill({ json: {} });
    });
    await page.goto('/player/download-recovery-test');
    await page.evaluate(async () => {
      const path = '/player/src/stores/index.ts';
      const { actions } = await import(/* @vite-ignore */ path);
      await actions.loadDownloads();
    });
    const ids = () => page.evaluate(async () => {
      const path = '/player/src/stores/index.ts';
      const { state } = await import(/* @vite-ignore */ path);
      return state.downloads.queue.map((item: { id: string }) => item.id);
    });
    expect(await ids()).toEqual(['job']);
    if (scenario === 'recovery') {
      await page.reload();
      await page.evaluate(async () => {
        const path = '/player/src/stores/index.ts';
        const { actions } = await import(/* @vite-ignore */ path);
        await actions.loadDownloads();
      });
      expect(await ids()).toEqual(['job']);
      return;
    }
    const action = page.evaluate(async () => {
      const path = '/player/src/stores/index.ts';
      const { actions } = await import(/* @vite-ignore */ path);
      await actions.removeDownload('job');
    });
    await expect.poll(() => requested).toBe(true);
    expect(await ids()).toEqual(['job']);
    release();
    await action;
    await expect.poll(ids).toEqual(scenario === 'failure' ? ['job'] : []);
  });
}
