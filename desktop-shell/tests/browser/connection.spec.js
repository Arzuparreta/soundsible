import { expect, test } from '@playwright/test';
import { mockTauri } from './tauri-mock.js';

const choose = { mode: 'choose', server: null, returning_user: false, auto_start: false };
test('a new desktop offers a server connection without starting an engine', async ({ page }) => {
  await mockTauri(page, { get_startup_profile: choose });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Where is your music?' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Server address' }).fill('http://localhost:5005');
  await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
  const calls = await page.evaluate(() => window.__commands);
  expect(calls).toContainEqual({ command: 'connect_server', args: { address: 'http://localhost:5005' } });
  expect(calls.some(c => ['start_engine', 'start_engine_with_path', 'start_configured_engine'].includes(c.command))).toBe(false);
});
test('choosing this computer reveals the existing folder flow', async ({ page }) => {
  await mockTauri(page, { get_startup_profile: choose });
  await page.goto('/');
  await page.getByRole('button', { name: 'Use this computer as server' }).click();
  await expect(page.getByRole('button', { name: 'Choose folder…' })).toBeVisible();
});
test('a remembered server reconnects without changing autostart or starting an engine', async ({ page }) => {
  await mockTauri(page, { get_startup_profile: { ...choose, mode: 'server', server: 'https://music.example' } });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__commands.filter(c => c.command === 'connect_server').length)).toBe(1);
  const calls = await page.evaluate(() => window.__commands);
  expect(calls).toContainEqual({ command: 'connect_server', args: { address: 'https://music.example' } });
  expect(calls.some(c => c.command === 'set_autostart' || c.command === 'start_configured_engine')).toBe(false);
});
