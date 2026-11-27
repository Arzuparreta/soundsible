import type { Navigator } from '@solidjs/router';
import { primaryDestination } from '../components/primaryNavigation';
import { TAB_RETURN_STATE } from './scrollHistory';
import { reselectPrimaryTab } from './tabNavigation';

/**
 * Where each primary destination was left, by its top-level route: `last` is
 * the subroute or filtered address last visited under it, and `root` is the
 * destination's own landing address (Discover keeps its search query). Artist
 * and album pages are neutral detail views, so visiting them leaves every
 * destination's saved location intact.
 *
 * Module scope, not storage: it describes this session's navigation, and
 * signing out reloads the page.
 */
const visited = new Map<string, { last: string; root?: string }>();

export function rememberTabLocation(pathname: string, search: string): void {
  const group = primaryDestination(pathname);
  if (!group) return;
  const location = `${pathname}${search}`;
  const isRoot = pathname === group;
  // Discover keeps its search query as its root surface; transient filters
  // on other routes stay in `last` without overriding the root address.
  const root = isRoot
    ? (group === '/search' ? location : group)
    : visited.get(group)?.root;
  visited.set(group, { last: location, root });
}

/** The destination's own page as it was left, if it was visited this session. */
export function tabRoot(href: string): string | undefined {
  return visited.get(href)?.root;
}

/**
 * A primary destination chosen from the tab bar, sidebar or drawer.
 * When `restoreSubroute` is enabled (the mobile tab bar), selecting an inactive
 * tab returns to its last visited subroute; otherwise (desktop sidebar and
 * mobile drawer) it navigates directly to the destination root. Selecting the
 * already-active destination climbs to its root, and once there re-selection
 * scrolls up (and, on Discover, focuses the search field).
 */
export function openPrimaryDestination(
  navigate: Navigator,
  href: string,
  selected: boolean,
  location: string,
  options: { restoreSubroute?: boolean } = {},
): void {
  const root = tabRoot(href) ?? href;
  if (selected && location === root) {
    reselectPrimaryTab(href);
    return;
  }
  const destination = selected
    ? root
    : options.restoreSubroute
      ? (visited.get(href)?.last ?? root)
      : root;
  navigate(destination, { state: { [TAB_RETURN_STATE]: true } });
}

/** Test-only reset for module-level session state. */
export function resetTabMemoryForTests(): void {
  visited.clear();
}
