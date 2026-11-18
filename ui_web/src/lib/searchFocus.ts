import { setNowPlayingOpen } from '../stores';
import { navigateMusic } from './musicNavigation';
import { tabRoot } from './tabMemory';

/**
 * Discover is a feed first and a search field second, so arriving there never
 * focuses the field by itself. It used to on desktop: every mount, Back from
 * an album included, opened recent searches over the feed and left the window
 * shortcuts (Space, K, M…) typing into the box until Escape or a click
 * elsewhere. The field now takes focus only when the listener asks to search:
 * a click on it, choosing Discover again while at its top
 * (`reselectPrimaryTab`), or `/` from anywhere (`openSearch`).
 */
let requested = false;

function focusField(field: HTMLInputElement): void {
  field.focus();
  // The query being refined stays; typing straight away replaces it.
  field.select();
}

/** `/`: go to Discover's search as it was left and put the cursor in it. */
export function openSearch(): void {
  const field = document.querySelector<HTMLInputElement>('[data-global-search-input]');
  if (field) {
    setNowPlayingOpen(false);
    focusField(field);
    return;
  }
  requested = true;
  navigateMusic(tabRoot('/search') ?? '/search');
}

/**
 * Discover's mount asks once whether it was opened to search. The request is
 * spent on that mount, so a later return to Discover — Back from an album —
 * arrives on the feed.
 */
export function focusRequestedSearch(field: HTMLInputElement | undefined): void {
  if (!requested) return;
  requested = false;
  if (field) requestAnimationFrame(() => focusField(field));
}
