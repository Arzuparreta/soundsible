import { createSignal } from 'solid-js';
import { defaultBottomNavigation, navigationItems } from '../components/primaryNavigation';
const KEY = 'navigation:bottom';
export function resolveBottomNavigation(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 5 || new Set(value).size !== value.length ||
      !value.every(href => navigationItems.some(item => item.href === href))) return [...defaultBottomNavigation];
  return [...value];
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
