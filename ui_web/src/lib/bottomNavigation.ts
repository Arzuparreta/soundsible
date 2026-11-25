import { createSignal } from 'solid-js';
import { defaultBottomNavigation, navigationItems } from '../components/primaryNavigation';
const KEY = 'navigation:bottom';
const LEGACY_SAVED = new Set(['/?saved=albums', '/?saved=artists']);
export function resolveBottomNavigation(value: unknown): string[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length) return [...defaultBottomNavigation];
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return [...defaultBottomNavigation];
    const href = LEGACY_SAVED.has(entry) ? '/?saved=bookmarks' : entry;
    if (normalized.includes(href)) {
      if (LEGACY_SAVED.has(entry)) continue;
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
