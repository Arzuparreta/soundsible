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
 */

/** The shell carries the whole settings tree, so it stays its own chunk. */
const SettingsShell = lazy(() => import('../components/SettingsShell'));

const [section, setSection] = createSignal<string | null>(null);
const [open, setOpen] = createSignal(false);

let dispose: (() => void) | null = null;

export const settingsOpen = open;

/**
 * `sectionId` opens straight into a submenu — a deep link, or the row someone
 * tapped. Unknown or inaccessible ids are the shell's problem to resolve: it
 * owns the registry and will fall back to the index.
 */
export function openSettings(sectionId?: string | null): void {
  const resume = desktopShell() ? section() : null;
  setSection(sectionId ?? resume);

  // Already up: a second call is a request to change section, not to stack a
  // second window on top of the first.
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
          <SettingsShell section={section()} onSectionChange={setSection} onClose={close} />
        </Suspense>
      );
    },
    // A thunk, not a string: a deep link can open this window in the same frame
    // the app boots, before the chosen dictionary has loaded.
    { variant: 'window', ariaLabel: () => t('settings.title') },
  );
}

export function closeSettings(): void {
  const handle = dispose;
  // Drop the state here rather than leaving it to the entry's cleanup: the
  // cleanup only runs if the window actually rendered, and a caller closing a
  // window that never got a frame still means it is closed.
  dispose = null;
  setOpen(false);
  handle?.();
}

export function toggleSettings(): void {
  if (open()) closeSettings();
  else openSettings();
}
