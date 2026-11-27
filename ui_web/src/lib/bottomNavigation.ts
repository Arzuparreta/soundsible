import { createSignal } from 'solid-js';
import { defaultBottomNavigation, navigationItems } from '../components/primaryNavigation';

const KEY = 'navigation:bottom';
const LEGACY_DESTINATIONS: Record<string, string> = {
  '/library': '/',
  '/library?view=songs': '/songs',
  '/library?view=albums': '/albums',
  '/library?view=artists': '/artists',
  '/?saved=bookmarks': '/bookmarks',
  '/?saved=albums': '/bookmarks',
  '/?saved=artists': '/bookmarks',
};

export function resolveBottomNavigation(value: unknown): string[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length) return [...defaultBottomNavigation];
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return [...defaultBottomNavigation];
    const href = LEGACY_DESTINATIONS[entry] ?? entry;
    if (normalized.includes(href)) {
      if (entry in LEGACY_DESTINATIONS) continue;
      return [...defaultBottomNavigation];
    }
    normalized.push(href);
  }
  if (normalized.length < 3 || normalized.length > 5 ||
      !normalized.every(href => navigationItems.some(item => item.href === href))) return [...defaultBottomNavigation];
  return normalized;
}
function load(): string[] {
  try { return resolveBottomNavigation(JSON.parse(localStorage.getItem(KEY) ?? 'null')); }
  catch { return [...defaultBottomNavigation]; }
}
export const [bottomNavigation, updateBottomNavigation] = createSignal(load());
export function setBottomNavigation(value: string[]): void {
  const next = resolveBottomNavigation(value);
  updateBottomNavigation(next);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Session preference still applies. */ }
}
