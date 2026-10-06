/** The public listener hub. Anyone can open a room there: no account, no
 * station, nothing to install — which is what makes a room worth sharing. */
export const LIVE_HUB_URL =
  import.meta.env.VITE_SOUNDSIBLE_LIVE_HUB ||
  'https://arzuparreta.github.io/soundsible.github.io/live/';

/** The address a listener should be given for a room. */
export function liveRoomLink(sessionId: string): string {
  const url = new URL(LIVE_HUB_URL);
  url.searchParams.set('session', sessionId);
  return url.href;
}

