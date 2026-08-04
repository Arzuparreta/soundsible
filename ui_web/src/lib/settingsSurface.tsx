import { createSignal, lazy, onCleanup, Suspense } from 'solid-js';
import { openOverlay } from './overlay';
import { desktopShell } from './shellLayout';
import { t } from './i18n';

/**
 * Settings is a window, not a destination. It opens over whatever you were
 * doing and gives it back when you close — which for a music player is the
 * point: the queue you were building is still there behind it.
 *
 * The window mounts as an entry in the ONE overlay registry rather than as a
 * portal of its own. That is not incidental: settings content opens nested
 * overlays constantly (confirm, prompt, password, action menus, device
 * pairing). Two portals at the same z-index would stack by DOM order; one
 * registry stacks by open order, which is the only order a user can reason
 * about.
 *
 * ── Why it touches history ──────────────────────────────────────────────
 * On a phone, back is a swipe, and a swipe has to mean something. A window
 * that owns no history entry lets that gesture unwind the page *behind* it:
 * the app navigates, the opaque window stays on top, and the whole thing
 * reads as a stuck screen. So opening the window pushes an entry, and going
 * back pops it — one level on desktop (the rail is always there, so back
 * means "leave settings"), two on mobile, where the submenu really is a push
 * over the index and back should return to it.
 *
 * The entry carries which submenu it belongs to, so a traversal in either
 * direction is restored by reading it rather than by counting steps.
 */

/** The shell carries the whole settings tree, so it stays its own chunk. */
const SettingsShell = lazy(() => import('../components/SettingsShell'));

const HISTORY_KEY = '__soundsibleSettings';

interface SettingsMark {
  /**
   * How many entries the window has pushed, so closing can unwind exactly
   * those. 2 only happens on mobile, where a submenu is a real push over the
   * index; on desktop the index never leaves, so there is only ever one.
   */
  depth: 1 | 2;
  /** Which submenu this entry belongs to, or null for the index. */
  section: string | null;
}

const [section, setSection] = createSignal<string | null>(null);
const [open, setOpen] = createSignal(false);

let dispose: (() => void) | null = null;
let listening = false;

export const settingsOpen = open;

function historyState(): Record<string, unknown> {
  const state = window.history.state;
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
}

function markFromHistory(state = historyState()): SettingsMark | null {
  const value = state[HISTORY_KEY];
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SettingsMark>;
  if (candidate.depth !== 1 && candidate.depth !== 2) return null;
  return { depth: candidate.depth, section: typeof candidate.section === 'string' ? candidate.section : null };
}

/** The mark rides along with whatever the router already wrote for this entry. */
function writeMark(mark: SettingsMark, push: boolean): void {
  const next = { ...historyState(), [HISTORY_KEY]: mark };
  if (push) window.history.pushState(next, '');
  else window.history.replaceState(next, '');
}

/**
 * Bring the window in line with the entry the browser just landed on. This is
 * the read side: it never writes history back, or a traversal would fight the
 * gesture that caused it.
 */
function applyMark(mark: SettingsMark | null): void {
  if (!mark) {
    if (open()) teardown();
    return;
  }
  setSection(mark.section);
  if (!open()) mount();
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('popstate', () => applyMark(markFromHistory()));
}

function mount(): void {
  if (open()) return;
  setOpen(true);
  dispose = openOverlay(
    (close) => {
      // Escape and scrim-dismiss remove the entry without going through
      // closeSettings, so the disposal of the entry's scope is what keeps
      // `settingsOpen` honest — the tab bar reads it.
      onCleanup(() => {
        setOpen(false);
        dispose = null;
      });
      return (
        <Suspense fallback={null}>
          <SettingsShell section={section()} onSectionChange={selectSection} onClose={close} />
        </Suspense>
      );
    },
    // A thunk, not a string: a deep link can open this window in the same frame
    // the app boots, before the chosen dictionary has loaded.
    { variant: 'window', ariaLabel: () => t('settings.title') },
  );
}

function teardown(): void {
  const handle = dispose;
  // Drop the state here rather than leaving it to the entry's cleanup: the
  // cleanup only runs if the window actually rendered, and a caller closing a
  // window that never got a frame still means it is closed.
  dispose = null;
  setOpen(false);
  setSection(null);
  handle?.();
}

/**
 * Changing submenu. On mobile this is a push over the index, so it earns a
 * history entry and back returns to the index. On desktop the index never left
 * the screen, so there is nothing to go back to and the entry is replaced.
 */
function selectSection(id: string | null): void {
  setSection(id);
  if (!open()) return;

  // Desktop stays one entry deep whatever pane is showing: the index never left
  // the screen, so there is no step to go back to, only a different pane.
  if (desktopShell()) {
    writeMark({ depth: 1, section: id }, false);
    return;
  }

  const current = markFromHistory();
  if (id && current?.depth === 1) {
    writeMark({ depth: 2, section: id }, true);
    return;
  }
  // Backing out of a submenu: let the browser do it, so the entry we pushed is
  // consumed rather than stranded ahead of us.
  if (!id && current?.depth === 2) {
    window.history.back();
    return;
  }
  writeMark(id ? { depth: 2, section: id } : { depth: 1, section: null }, false);
}

/**
 * `sectionId` opens straight into a submenu — a deep link, or the row someone
 * tapped. Unknown or inaccessible ids are the shell's problem to resolve: it
 * owns the registry and will fall back to the index.
 */
export function openSettings(sectionId?: string | null): void {
  listen();

  // Already up: a second call is a request to change section, not to stack a
  // second window on top of the first.
  if (open()) {
    if (sectionId) selectSection(sectionId);
    return;
  }

  const resume = desktopShell() ? section() : null;
  const target = sectionId ?? resume;
  setSection(target);

  if (desktopShell()) {
    // One entry: the index is always on screen, so back means "leave settings".
    writeMark({ depth: 1, section: target }, true);
  } else {
    // Two, when a deep link lands straight in a submenu — the index has to
    // exist underneath it or back would leave settings from a screen the user
    // never chose to be the bottom of the stack.
    writeMark({ depth: 1, section: null }, true);
    if (target) writeMark({ depth: 2, section: target }, true);
  }
  mount();
}

/**
 * Closing unwinds the entries the window pushed, so the address bar and the
 * back button end up where they were before it opened. The popstate that
 * follows is what actually tears the window down.
 */
export function closeSettings(): void {
  if (!open()) return;
  const depth = markFromHistory()?.depth ?? 0;
  // Tear down first so the caller sees a closed window immediately; the
  // popstate that follows finds nothing to do, which is exactly right.
  teardown();
  if (depth > 0) window.history.go(-depth);
}

/**
 * Leave settings for a full page. The pushed entries stay put on purpose: you
 * came here from settings, so back should bring you back to settings.
 */
export function dismissSettings(): void {
  teardown();
}

export function toggleSettings(): void {
  if (open()) closeSettings();
  else openSettings();
}
