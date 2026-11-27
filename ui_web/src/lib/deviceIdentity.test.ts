import { afterEach, describe, expect, it } from 'vitest';
import {
  detectDeviceName,
  detectFormFactor,
  isDesktopShell,
  isTouchFormFactor,
  isTvShell,
  TV_REMOTE_COMMANDS,
  type DeviceEnvironment,
} from './deviceIdentity';

const env = (overrides: Partial<DeviceEnvironment> = {}): DeviceEnvironment => ({
  userAgent: '',
  maxTouchPoints: 0,
  coarsePointer: false,
  shortSide: 1080,
  desktop: false,
  ...overrides,
});

describe('deviceIdentity', () => {
  it('derives default name and form factor for iPhone Safari', () => {
    const e = env({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 5,
      coarsePointer: true,
      shortSide: 390,
    });
    expect(detectDeviceName(e)).toBe('Safari · iPhone');
    expect(detectFormFactor(e)).toBe('phone');
  });

  it('derives default name and form factor for Android Chrome', () => {
    const e = env({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      maxTouchPoints: 5,
      coarsePointer: true,
      shortSide: 412,
    });
    expect(detectDeviceName(e)).toBe('Chrome · Android');
    expect(detectFormFactor(e)).toBe('phone');
  });

  it('derives default name and tablet form factor for iPad (classic and iPadOS Mac UA)', () => {
    const classic = env({
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 5,
      coarsePointer: true,
      shortSide: 768,
    });
    expect(detectDeviceName(classic)).toBe('Safari · iPad');
    expect(detectFormFactor(classic)).toBe('tablet');

    const ipados = env({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      maxTouchPoints: 5,
      coarsePointer: false,
      shortSide: 820,
    });
    expect(detectDeviceName(ipados)).toBe('Safari · iPad');
    expect(detectFormFactor(ipados)).toBe('tablet');
  });

  it('derives default name and computer form factor for Linux Firefox', () => {
    const e = env({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
      coarsePointer: false,
      shortSide: 1080,
    });
    expect(detectDeviceName(e)).toBe('Firefox · Linux');
    expect(detectFormFactor(e)).toBe('computer');
  });

  it('derives default name and computer form factor for Windows Edge', () => {
    const e = env({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
      coarsePointer: false,
      shortSide: 1080,
    });
    expect(detectDeviceName(e)).toBe('Edge · Windows');
    expect(detectFormFactor(e)).toBe('computer');
  });

  it('derives desktop shell name and forces computer form factor', () => {
    const win = env({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
      coarsePointer: true,
      shortSide: 500,
      desktop: true,
    });
    expect(detectDeviceName(win)).toBe('Soundsible · Windows');
    expect(detectFormFactor(win)).toBe('computer');

    const linux = env({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)',
      desktop: true,
    });
    expect(detectDeviceName(linux)).toBe('Soundsible · Linux');
    expect(detectFormFactor(linux)).toBe('computer');
  });

  describe('isDesktopShell', () => {
    const originalPath = window.location.pathname;
    afterEach(() => {
      window.history.replaceState(null, '', originalPath);
      delete (window as Window & { __SOUNDSIBLE_DESKTOP__?: unknown }).__SOUNDSIBLE_DESKTOP__;
      delete (window as Window & { __SOUNDSIBLE_OWNER_TOKEN__?: string }).__SOUNDSIBLE_OWNER_TOKEN__;
    });

    it('detects /player/desktop/, desktopBridge, and ownerToken', () => {
      window.history.replaceState(null, '', '/player/');
      expect(isDesktopShell()).toBe(false);

      window.history.replaceState(null, '', '/player/desktop/');
      expect(isDesktopShell()).toBe(true);

      window.history.replaceState(null, '', '/player/');
      (window as Window & { __SOUNDSIBLE_DESKTOP__?: unknown }).__SOUNDSIBLE_DESKTOP__ = { appearance: async () => {} };
      expect(isDesktopShell()).toBe(true);
      delete (window as Window & { __SOUNDSIBLE_DESKTOP__?: unknown }).__SOUNDSIBLE_DESKTOP__;

      (window as Window & { __SOUNDSIBLE_OWNER_TOKEN__?: string }).__SOUNDSIBLE_OWNER_TOKEN__ = 'owner-secret';
      expect(isDesktopShell()).toBe(true);
    });
  });

  describe('TV identity and commands', () => {
    const originalPath = window.location.pathname;
    afterEach(() => {
      window.history.replaceState(null, '', originalPath);
      delete document.documentElement.dataset.surface;
    });

    it('detects TV shell via data-surface or /tv/ route and marks TV as non-touch', () => {
      expect(isTvShell()).toBe(false);
      document.documentElement.dataset.surface = 'tv';
      expect(isTvShell()).toBe(true);
      expect(detectFormFactor()).toBe('tv');
      expect(isTouchFormFactor()).toBe(false);

      delete document.documentElement.dataset.surface;
      window.history.replaceState(null, '', '/tv/');
      expect(isTvShell()).toBe(true);
    });

    it('formats TV default names and excludes DJ, radio, and software volume commands', () => {
      expect(detectDeviceName(env({ tv: true, userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV)' }))).toBe('LG webOS TV');
      expect(detectDeviceName(env({ tv: true, userAgent: 'SMART-TV; Tizen 7.0' }))).toBe('Samsung TV');
      expect(detectDeviceName(env({ tv: true, userAgent: 'Mozilla/5.0' }))).toBe('Smart TV');

      expect(TV_REMOTE_COMMANDS).toContain('transport.play');
      expect(TV_REMOTE_COMMANDS).toContain('transport.seek');
      expect(TV_REMOTE_COMMANDS).toContain('queue.play_entry');
      expect(TV_REMOTE_COMMANDS).not.toContain('transport.set_volume');
      expect(TV_REMOTE_COMMANDS).not.toContain('transport.set_muted');
      expect(TV_REMOTE_COMMANDS).not.toContain('radio.start');
      expect(TV_REMOTE_COMMANDS.some((cmd) => cmd.startsWith('dj.'))).toBe(false);
    });
  });
});
