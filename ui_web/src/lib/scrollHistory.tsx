import { createEffect, onCleanup, onMount } from 'solid-js';
import { useIsRouting, useLocation, type Navigator } from '@solidjs/router';

const HISTORY_STATE_KEY = '__soundsibleScroll';

interface ScrollEntryState {
  id: string;
  parentId?: string;
}

interface ScrollRegistration {
  element: HTMLElement;
  ready: () => boolean;
}

interface PendingRestore {
  entryId: string;
  route: string;
  top: number;
}

const positions = new Map<string, number>();
const registrations = new Set<ScrollRegistration>();

let activeEntry: ScrollEntryState | null = null;
let activeDepth: number | null = null;
let activeRoute = '';
let pendingPopId: string | null = null;
let pendingRestore: PendingRestore | null = null;
let restoreFrame: number | null = null;
let settleFrame: number | null = null;
let fallbackSequence = 0;

function routeKey(): string {
  return `${window.location.hash || '#/'}`;
}

function stateRecord(): Record<string, unknown> {
  const state = window.history.state;
  return state && typeof state === 'object' ? state as Record<string, unknown> : {};
}

function entryFromState(state = stateRecord()): ScrollEntryState | null {
  const value = state[HISTORY_STATE_KEY];
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ScrollEntryState>;
  return typeof candidate.id === 'string' && candidate.id
    ? { id: candidate.id, parentId: typeof candidate.parentId === 'string' ? candidate.parentId : undefined }
    : null;
}

function historyDepth(state = stateRecord()): number | null {
  return typeof state._depth === 'number' ? state._depth : null;
}

function nextEntryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackSequence += 1;
  return `soundsible-${Date.now()}-${fallbackSequence}`;
}

function writeEntry(entry: ScrollEntryState): void {
  const state = stateRecord();
  window.history.replaceState({ ...state, [HISTORY_STATE_KEY]: entry }, '');
}

function cancelRestore(): void {
  pendingRestore = null;
  if (restoreFrame != null) {
    cancelAnimationFrame(restoreFrame);
    restoreFrame = null;
  }
}

function activeRegistration(): ScrollRegistration | null {
  for (const registration of registrations) {
    if (registration.element.isConnected) return registration;
  }
  return null;
}

/**
 * Restore once, after the route says its content is complete. There are no
 * geometry reads or retry loops: the browser clamps an obsolete offset
 * naturally if the reconstructed page is genuinely shorter.
 */
function tryRestore(): void {
  const pending = pendingRestore;
  if (!pending || pending.entryId !== activeEntry?.id || pending.route !== activeRoute) return;
  const registration = activeRegistration();
  if (!registration || !registration.ready() || restoreFrame != null) return;

  restoreFrame = requestAnimationFrame(() => {
    restoreFrame = null;
    if (
      pendingRestore !== pending
      || pending.entryId !== activeEntry?.id
      || pending.route !== activeRoute
      || !registration.element.isConnected
      || !registration.ready()
    ) {
      return;
    }
    pendingRestore = null;
    registration.element.scrollTop = pending.top;
    positions.set(pending.entryId, registration.element.scrollTop);
  });
}

function settleRoute(): void {
  settleFrame = null;
  const state = stateRecord();
  const depth = historyDepth(state);
  const stateEntry = entryFromState(state);
  const route = routeKey();
  const traversed = !!pendingPopId && stateEntry?.id === pendingPopId;
  const replacedCurrent = !stateEntry && activeEntry != null && depth === activeDepth;

  let entry: ScrollEntryState;
  let fresh = false;
  if (stateEntry) {
    entry = stateEntry;
    if (entry.id !== activeEntry?.id && !traversed) {
      // An entry supplied by application code is still a fresh destination.
      fresh = true;
    }
  } else {
    if (replacedCurrent && activeEntry) {
      entry = activeEntry;
    } else {
      entry = { id: nextEntryId(), parentId: activeEntry?.id };
      fresh = activeEntry != null;
    }
    writeEntry(entry);
  }

  activeEntry = entry;
  activeDepth = depth;
  activeRoute = route;

  const saved = positions.get(entry.id);
  if (traversed && saved != null) {
    pendingRestore = { entryId: entry.id, route, top: saved };
  } else if (fresh) {
    pendingRestore = { entryId: entry.id, route, top: 0 };
    positions.set(entry.id, 0);
  } else if (pendingRestore?.entryId !== entry.id) {
    cancelRestore();
  }

  pendingPopId = null;
  tryRestore();
}

function scheduleSettle(): void {
  if (settleFrame != null) cancelAnimationFrame(settleFrame);
  settleFrame = requestAnimationFrame(settleRoute);
}

/**
 * Mounted once inside the HashRouter. It waits until Solid Router has committed
 * its transition, because only then has HashRouter stamped/pushed the real
 * browser-history entry.
 */
export function ScrollHistoryManager() {
  const location = useLocation();
  const isRouting = useIsRouting();

  onMount(() => {
    const onPopState = () => {
      pendingPopId = entryFromState()?.id ?? null;
    };
    window.addEventListener('popstate', onPopState);
    scheduleSettle();
    onCleanup(() => {
      window.removeEventListener('popstate', onPopState);
      if (settleFrame != null) cancelAnimationFrame(settleFrame);
      cancelRestore();
    });
  });

  createEffect(() => {
    // Track the full routed identity; query-only replacements matter too.
    void location.pathname;
    void location.search;
    void location.hash;
    if (!isRouting()) scheduleSettle();
  });

  return null;
}

/**
 * Register the single route-level vertical scroller. `ready` must become true
 * only after asynchronous content that determines the page height has rendered.
 */
export function registerPrimaryScroll(element: HTMLElement, ready: () => boolean = () => true): void {
  const registration = { element, ready };
  registrations.add(registration);

  const onScroll = () => {
    if (!activeEntry || element !== activeRegistration()?.element) return;
    positions.set(activeEntry.id, element.scrollTop);
  };
  const cancelPending = () => {
    if (pendingRestore?.entryId === activeEntry?.id) cancelRestore();
  };

  element.addEventListener('scroll', onScroll, { passive: true });
  element.addEventListener('pointerdown', cancelPending, { passive: true });
  element.addEventListener('touchstart', cancelPending, { passive: true });
  element.addEventListener('wheel', cancelPending, { passive: true });

  createEffect(() => {
    void ready();
    tryRestore();
  });

  onCleanup(() => {
    registrations.delete(registration);
    element.removeEventListener('scroll', onScroll);
    element.removeEventListener('pointerdown', cancelPending);
    element.removeEventListener('touchstart', cancelPending);
    element.removeEventListener('wheel', cancelPending);
  });
}

/**
 * Detail-page back semantics: traverse only when this entry was created inside
 * Soundsible. A directly opened universal/deep link stays in the app.
 */
export function navigateBackOr(navigate: Navigator, fallback: string): void {
  if (entryFromState()?.parentId) navigate(-1);
  else navigate(fallback, { replace: true });
}

/** Test-only reset for module-level session state. */
export function resetScrollHistoryForTests(): void {
  positions.clear();
  registrations.clear();
  activeEntry = null;
  activeDepth = null;
  activeRoute = '';
  pendingPopId = null;
  pendingRestore = null;
  if (restoreFrame != null) cancelAnimationFrame(restoreFrame);
  if (settleFrame != null) cancelAnimationFrame(settleFrame);
  restoreFrame = null;
  settleFrame = null;
  fallbackSequence = 0;
}
