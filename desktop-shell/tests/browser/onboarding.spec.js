import { expect, test } from '@playwright/test';

async function mockTauri(page) {
  await page.addInitScript(() => {
    let callbackId = 0;
    const callbacks = new Map();
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event, id) => callbacks.delete(id),
    };
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) {
        callbackId += 1;
        callbacks.set(callbackId, callback);
        return callbackId;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      runCallback(id, payload) {
        callbacks.get(id)?.(payload);
      },
      async invoke(command) {
        if (command === 'plugin:event|listen') return callbackId;
        if (command === 'get_engine_status') {
          return { phase: 'idle', log_lines: [] };
        }
        if (command === 'get_autostart') return false;
        if (command === 'get_startup_profile') {
          return {
            returning_user: false,
            music_dir: null,
            auto_start: false,
            configured_but_missing: false,
          };
        }
        if (command === 'plugin:dialog|open') return window.__dialogResult ?? null;
        if (command === 'preview_music_folder') {
          return {
            path: window.__dialogResult,
            track_count: 12,
            size_bytes: 1_572_864,
            scan_ms: 150,
            inaccessible_entries: 0,
            writable: true,
          };
        }
        if (command === 'start_engine_with_path') return null;
        if (command === 'set_autostart') return null;
        if (command === 'log_shell_event') return null;
        return null;
      },
    };
  });
}

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

test('cancel remains recoverable and a Unicode folder enables Continue', async ({ page }) => {
  await page.goto('/');
  const choose = page.getByRole('button', { name: 'Choose folder…' });
  const proceed = page.getByRole('button', { name: 'Continue' });

  await choose.click();
  await expect(page.getByText('No folder selected')).toBeVisible();
  await expect(proceed).toBeDisabled();

  await page.evaluate(() => { window.__dialogResult = 'C:\\Users\\QA\\Música de prueba'; });
  await choose.click();
  await expect(page.getByText('C:\\Users\\QA\\Música de prueba')).toBeVisible();
  await expect(page.getByText(/12 tracks · 1.5 MB/)).toBeVisible();
  await expect(proceed).toBeEnabled();
});

test('minimum window and 200 percent zoom never create horizontal overlap', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/');
  await page.evaluate(() => { document.body.style.zoom = '2'; });

  const geometry = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('button, input')];
    return {
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      outside: controls.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).length,
    };
  });
  expect(geometry).toEqual({ horizontalOverflow: false, outside: 0 });
});

test('system locale translates first-run without changing accessible controls', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'es-ES' });
  const page = await context.newPage();
  await mockTauri(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Elige tu carpeta de música.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Elegir carpeta…' })).toBeVisible();
  await context.close();
});
