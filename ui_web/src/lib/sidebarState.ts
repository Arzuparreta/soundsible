import { createSignal } from 'solid-js';
import { dismissContextMenu } from './contextMenu';

const COLLAPSED_KEY = 'sidebar:collapsed:v1';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(COLLAPSED_KEY, '1');
    else localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    /* storage unavailable */
  }
}

function syncDocumentAttribute(collapsed: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.toggleAttribute('data-sidebar-collapsed', collapsed);
}

const [collapsedSignal, setCollapsedSignal] = createSignal(readCollapsed());
syncDocumentAttribute(collapsedSignal());

/** Whether the desktop sidebar is collapsed into its compact icon rail. */
export const sidebarCollapsed = collapsedSignal;

export function setSidebarCollapsed(next: boolean): void {
  if (collapsedSignal() === next) return;
  setCollapsedSignal(next);
  writeCollapsed(next);
  syncDocumentAttribute(next);
  dismissContextMenu();
}

export function toggleSidebarCollapsed(): void {
  setSidebarCollapsed(!collapsedSignal());
}

/** Test-only reset for module-level persistence and DOM state. */
export function resetSidebarStateForTests(): void {
  try {
    localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    /* storage unavailable */
  }
  setCollapsedSignal(false);
  syncDocumentAttribute(false);
}
