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
test('a desktop that refuses autostart still connects, and the box says so', async ({ page }) => {
  await mockTauri(page, {
    get_startup_profile: choose,
    set_autostart: { reject: 'Background portal unavailable' },
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Server address' }).fill('http://localhost:5005');
  const autostart = page.locator('#chk-client-autostart');
  await autostart.check();
  await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__commands.some(c => c.command === 'connect_server'))).toBe(true);
  await expect(autostart).not.toBeChecked();
  await expect(page.locator('#connection-error')).toBeHidden();
});

test('selecting local cancels a server continuation waiting for autostart', async ({ page }) => {
  await mockTauri(page, { get_startup_profile: choose, set_autostart: { defer: true } });
  await page.goto('/');
  await page.getByLabel('Server address').fill('https://music.example');
  await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__commands.some(c => c.command === 'set_autostart'))).toBe(true);
  await page.getByRole('button', { name: 'Use this computer as server' }).click();
  await page.evaluate(() => window.__releaseCommand('set_autostart'));
  await expect(page.getByRole('button', { name: 'Choose folder…' })).toBeVisible();
  const calls = await page.evaluate(() => window.__commands);
  expect(calls.some(c => c.command === 'cancel_server_connection')).toBe(true);
  expect(calls.some(c => c.command === 'connect_server')).toBe(false);
});

test('a late remote error cannot replace the selected local setup', async ({ page }) => {
  await mockTauri(page, { get_startup_profile: choose, connect_server: { defer: true } });
  await page.goto('/');
  await page.getByLabel('Server address').fill('https://music.example');
  await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__commands.some(c => c.command === 'connect_server'))).toBe(true);
  await page.getByRole('button', { name: 'Use this computer as server' }).click();
  await page.evaluate(() => window.__releaseCommand('connect_server', null, 'Old server failed'));
  await expect(page.getByRole('button', { name: 'Choose folder…' })).toBeVisible();
  await expect(page.locator('#connection-error')).toBeHidden();
});

test('a remembered-server profile arriving after local selection cannot reconnect', async ({ page }) => {
  await mockTauri(page, { get_startup_profile: { defer: true } });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__commands.some(c => c.command === 'get_startup_profile'))).toBe(true);
  await page.getByRole('button', { name: 'Use this computer as server' }).click();
  await page.evaluate(() => window.__releaseCommand('get_startup_profile', {
    mode: 'server', server: 'https://music.example', returning_user: true,
  }));
  await expect(page.getByRole('button', { name: 'Choose folder…' })).toBeVisible();
  expect(await page.evaluate(() => window.__commands.some(c => c.command === 'connect_server'))).toBe(false);
});
