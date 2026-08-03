/**
 * Moving a session from the insecure station to its secure twin.
 *
 * Broadcasting needs a trustworthy origin, so a station reached over plain HTTP
 * can only offer the HTTPS address of the same engine. Following that link is a
 * device handoff in every way that matters — a different origin means a
 * different device id, a different store, a different everything — and it used
 * to land the listener on a Live page with nothing started and no memory of
 * what they were doing when they pressed the button.
 *
 * The marker in the link is what makes the trip mean "go live", so the arriving
 * page opens the room by itself and knows to wait for the session its own
 * departure is still publishing.
 */
const HANDOFF_PARAM = 'handoff';
const HANDOFF_LIVE = 'live';

/** Where the player lives on the secure origin. Same engine, same paths. */
const PLAYER_LIVE_PATH = '/player/#/live';

/** The address to hand someone whose station is not a secure context. */
export function secureLiveHandoffUrl(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(PLAYER_LIVE_PATH, origin);
    url.hash = `${url.hash}?${HANDOFF_PARAM}=${HANDOFF_LIVE}`;
    return url.href;
  } catch {
    return null;
  }
}

/** The query the router sees, which lives inside the hash — not `location.search`. */
function hashQuery(hash: string): URLSearchParams {
  const at = hash.indexOf('?');
  return new URLSearchParams(at === -1 ? '' : hash.slice(at + 1));
}

/**
 * Whether this page was opened to carry a live session over.
 *
 * A plain read: the store asks it at boot to know how long to keep looking for
 * the session being handed over, and Live asks it again when it mounts.
 */
export function liveHandoffPending(hash: string = window.location.hash): boolean {
  return hashQuery(hash).get(HANDOFF_PARAM) === HANDOFF_LIVE;
}

/**
 * Spend the marker, so a reload is an ordinary visit to Live rather than a
 * second attempt to open a room. Rewritten in place: a router navigation here
 * would be a history entry whose only content is the thing we just consumed.
 */
export function clearLiveHandoff(): void {
  if (typeof window === 'undefined' || !liveHandoffPending()) return;
  const hash = window.location.hash;
  const at = hash.indexOf('?');
  const params = hashQuery(hash);
  params.delete(HANDOFF_PARAM);
  const rest = params.toString();
  const next = `${at === -1 ? hash : hash.slice(0, at)}${rest ? `?${rest}` : ''}`;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${next}`);
}
