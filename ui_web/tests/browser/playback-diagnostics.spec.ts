import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { mockMusicEngine } from './music-browser-fixture';

test('captures locally, locks the variant and exports an ordered diagnostic file', async ({ page }) => {
  await mockMusicEngine(page);
  await page.goto('/player/#/settings/playback');
  await page.getByRole('textbox', { name: 'Versión exacta de iOS' }).fill('999');
  await page.getByRole('combobox', { name: 'Prueba', exact: true }).selectOption('excluded');
  await page.getByRole('button', { name: /Iniciar nueva captura/ }).click();
  await expect(page.getByRole('button', { name: 'Pausar y finalizar captura' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Prueba', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Marcar fallo de los controles de volumen' }).click();
  await page.getByRole('button', { name: 'Pausar y finalizar captura' }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar captura' }).click();
  const download = await downloaded;
  const data = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(data.active).toBe(false);
  expect(data.setup.variant).toBe('excluded');
  expect(data.setup.ios).toBe('999');
  expect(data.setup.clientRevision).toBe('development-unverified');
  expect(data.dropped).toBe(0);
  expect(data.events.some((row: { event: string }) => row.event === 'human.volume_failed')).toBe(true);
  expect(data.events.at(-1).event).toBe('capture.stop');
  expect(data.events.every((row: { sequence: number }, index: number) => row.sequence === index + 1)).toBe(true);
  expect(JSON.stringify(data)).not.toContain('library-track-');
});
