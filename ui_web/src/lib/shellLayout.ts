import { createSignal } from 'solid-js';
import { state } from '../stores';

/**
 * Whether the app is composed as a desktop shell — the same question
 * `app.module.css` answers in CSS to choose between the left rail and the
 * bottom tab bar.
 *
 * It is deliberately not a bare `min-width: 1024px`. At the Large interface
 * size the shell keeps the mobile composition through small desktop windows
 * (app.module.css: the rail only earns its place from 1280px up), because two
 * undersized columns of oversized text are worse than one good one.
 *
 * Expressing that compound condition once, here, is what keeps a responsive
 * layout from being written three times in a stylesheet — base, desktop, and
 * again to undo desktop for Large.
 */

const DESKTOP_QUERY = '(min-width: 1024px)';
const WIDE_QUERY = '(min-width: 1280px)';

function trackMedia(query: string): () => boolean {
  const [matches, setMatches] = createSignal(false);
  // jsdom and any non-DOM consumer get the mobile composition, which is the
  // safe default: it renders every control rather than hiding some behind a
  // split view.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    mq.addEventListener('change', (event) => setMatches(event.matches));
  }
  return matches;
}

const atLeastDesktop = trackMedia(DESKTOP_QUERY);
const atLeastWide = trackMedia(WIDE_QUERY);

export function desktopShell(): boolean {
  return atLeastDesktop() && (state.interfaceSize !== 'large' || atLeastWide());
}
