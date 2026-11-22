import { desktopBridge } from './desktopBridge';

export type DeviceFormFactor = 'phone' | 'tablet' | 'computer';

/** Every command the web target executor implements and declares on registration. */
export const WEB_REMOTE_COMMANDS = [
  'transport.play',
  'transport.pause',
  'transport.next',
  'transport.previous',
  'transport.seek',
  'transport.set_shuffle',
  'transport.set_repeat',
  'transport.set_volume',
  'play.tracks',
  'queue.add',
  'queue.move',
  'queue.remove',
  'queue.play_entry',
  'radio.start',
  'radio.stop',
  'dj.start',
  'dj.start_from_current',
  'dj.stop',
  'dj.place',
  'dj.promote',
  'dj.avoid',
  'dj.add_source',
  'dj.remove_source',
  'dj.change_session',
  'dj.repair',
  'dj.set_mixing',
  'session.export',
  'session.import',
  'session.release',
] as const;

export type WebRemoteCommand = (typeof WEB_REMOTE_COMMANDS)[number];

export interface DeviceEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  coarsePointer: boolean;
  shortSide: number;
  desktop: boolean;
}

function hasOwnerToken(): boolean {
  const runtimeWindow = window as Window & { __SOUNDSIBLE_OWNER_TOKEN__?: string };
  if (runtimeWindow.__SOUNDSIBLE_OWNER_TOKEN__?.trim()) return true;
  if (typeof document === 'undefined') return false;
  return Boolean(document.querySelector('meta[name="soundsible-owner-token"]')?.getAttribute('content')?.trim());
}

export function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location?.pathname?.startsWith('/player/desktop') === true ||
    Boolean(desktopBridge()) ||
    hasOwnerToken()
  );
}

function readEnvironment(): DeviceEnvironment {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const maxTouchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0;
  const coarsePointer =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false;
  let shortSide = Infinity;
  if (typeof window !== 'undefined') {
    const sw = window.screen?.width || 0;
    const sh = window.screen?.height || 0;
    if (sw > 0 && sh > 0) shortSide = Math.min(sw, sh);
    else if (window.innerWidth > 0 && window.innerHeight > 0) {
      shortSide = Math.min(window.innerWidth, window.innerHeight);
    }
  }
  return { userAgent: ua, maxTouchPoints, coarsePointer, shortSide, desktop: isDesktopShell() };
}

function detectBrowser(ua: string): string | null {
  if (/Edg(?:A|iOS)?\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/SamsungBrowser\//i.test(ua)) return 'Samsung Internet';
  if (/Firefox\/|FxiOS\//i.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  return null;
}

function detectPlatform(ua: string, maxTouchPoints: number): string | null {
  if (/iPhone|iPod/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return maxTouchPoints > 1 ? 'iPad' : 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return null;
}

export function detectFormFactor(env: DeviceEnvironment = readEnvironment()): DeviceFormFactor {
  if (env.desktop) return 'computer';
  if (env.coarsePointer) return env.shortSide < 600 ? 'phone' : 'tablet';
  if (/Macintosh|Mac OS X/i.test(env.userAgent) && env.maxTouchPoints > 1) return 'tablet';
  return 'computer';
}

export function detectDeviceName(env: DeviceEnvironment = readEnvironment()): string {
  const app = env.desktop ? 'Soundsible' : detectBrowser(env.userAgent);
  const platform = detectPlatform(env.userAgent, env.maxTouchPoints);
  if (app && platform) return `${app} · ${platform}`;
  return app || platform || 'Soundsible';
}
