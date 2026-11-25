import type { Navigator } from '@solidjs/router';
import { mobileNavGroup } from '../components/primaryNavigation';
import { bottomNavigation } from './bottomNavigation';
import { reselectPrimaryTab } from './tabNavigation';

/** History state on an entry a primary tab restored (`lib/tabNavigation`). Its
 * page comes back where it was scrolled, and it has no parent: the page's back
 * arrow climbs to its tab's root rather than into the tab the listener left. */
export const TAB_RETURN_STATE = '__soundsibleTabReturn';

/**
 * Where each primary destination was left, by its navigation group: `last` is
 * the page the listener was on, `root` the destination's own page as they left
 * it — Search with its query, Library on its view. Details inherit the section that opened them.
 *
 * Module scope, not storage: it describes this session's navigation, and
 * signing out reloads the page.
 */
const visited = new Map<string, { last: string; owner: string; root?: string }>();

export function rememberTabLocation(pathname: string, search: string): void {
  const own = mobileNavGroup(pathname, search);
  // Library's own views are Library's, unless the bar gives them a tab.
  const group = own !== '/' && (own.startsWith('/library?') || own.startsWith('/?saved=')) && !bottomNavigation().includes(own) ? '/' : own;
  const location = `${pathname}${search}`;
  const root = own === group && pathname === group.split('?')[0];
  visited.set(group, { last: location, owner: own, root: root ? location : visited.get(group)?.root });
}

/** The destination's own page as it was left, if it was visited this session. */
export function tabRoot(href: string): string | undefined {
  return visited.get(href)?.root;
}

/**
 * A primary destination chosen from the tab bar, sidebar or drawer. An inactive
 * one returns where it was left; the active one climbs to its root, and once
 * there re-selection scrolls up (and, on Search, opens the keyboard).
 */
export function openPrimaryDestination(navigate: Navigator, href: string, selected: boolean, location: string): void {
  const root = tabRoot(href) ?? href;
  if (selected && location === root) {
    reselectPrimaryTab(href);
    return;
  }
  const destination = selected ? root : visited.get(href)?.last ?? href;
  navigate(destination, { state: { [TAB_RETURN_STATE]: true, tabGroup: selected ? href : visited.get(href)?.owner ?? href } });
}

/** Test-only reset for module-level session state. */
export function resetTabMemoryForTests(): void {
  visited.clear();
}
