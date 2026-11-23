/**
 * How the open player sits on a desktop screen.
 *
 * The player used to cover the whole app, so a panel inside it had to stand in
 * for Soundsible's own navigation, and could only ever be a second, lesser copy
 * of it. Docked — the default — it is a column on the right and the app stays
 * where it was beside it: its search, Discover and library, with every action
 * they already offer. Full screen is the room-filling stage it always was, for
 * when the music is all there is to look at.
 *
 * A phone has no room beside the player, so there it always fills the screen.
 */
import { createSignal } from 'solid-js';
import { desktopShell } from './shellLayout';
import { djErrand } from './djErrand';

export type PlayerPresentation = 'docked' | 'full';

const PRESENTATION_KEY = 'player:presentation:v1';
const DOCK_WIDTH_KEY = 'player:dockWidth:v1';

/** The column's width in CSS pixels: wide enough for the stage's controls and
 * a queue row's title, never more than half the window. */
export const DOCK_WIDTH = { min: 360, default: 420, max: 720 } as const;

/** Below this width the player uses its narrow composition — one panel at a
 * time with a pager — whatever the window is. A docked column always does. */
export const PLAYER_COMPACT_BELOW = 1024;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

/** The widest column a window of `viewport` pixels can give: half of it,
 * within the column's own bounds. */
export function maxDockWidth(viewport: number): number {
  return Math.max(DOCK_WIDTH.min, Math.min(DOCK_WIDTH.max, Math.floor(viewport / 2)));
}

/** A width the window can give the column: the chosen one, kept between the
 * column's own bounds and half the window. */
export function clampDockWidth(width: number, viewport: number): number {
  const max = maxDockWidth(viewport);
  if (!Number.isFinite(width)) return Math.min(DOCK_WIDTH.default, max);
  return Math.round(Math.max(DOCK_WIDTH.min, Math.min(max, width)));
}

const [presentation, setPresentationSignal] = createSignal<PlayerPresentation>(
  read(PRESENTATION_KEY) === 'full' ? 'full' : 'docked',
);
// The width the listener chose. A narrower window shows less of it without
// forgetting it, so widening the window again brings it back.
const [dockWidth, setDockWidthSignal] = createSignal(Number(read(DOCK_WIDTH_KEY)) || DOCK_WIDTH.default);
const [viewport, setViewport] = createSignal(typeof window === 'undefined' ? DOCK_WIDTH.max * 2 : window.innerWidth);
if (typeof window !== 'undefined') window.addEventListener('resize', () => setViewport(window.innerWidth), { passive: true });
// A docked column is never as wide as the compact threshold, so a docked player
// starts compact instead of mounting its wide layout for one frame.
const [compact, setCompact] = createSignal(
  typeof window === 'undefined' || window.innerWidth < PLAYER_COMPACT_BELOW || presentation() === 'docked',
);

export const playerPresentation = presentation;

/** The column's width in this window. */
export const playerDockWidth = (): number => clampDockWidth(dockWidth(), viewport());

/** The widest the column can be in this window. */
export const playerDockMaxWidth = (): number => maxDockWidth(viewport());

export function setPlayerPresentation(next: PlayerPresentation): void {
  setPresentationSignal(next);
  write(PRESENTATION_KEY, next);
}

export function setPlayerDockWidth(width: number): void {
  const next = clampDockWidth(width, viewport());
  setDockWidthSignal(next);
  write(DOCK_WIDTH_KEY, String(next));
}

/** Whether the open player is a column beside the app rather than over it.
 * A DJ errand docks it while it lasts: the music it asks for is chosen in the
 * app, so the app has to be there. */
export function playerDocked(): boolean {
  return desktopShell() && (presentation() === 'docked' || djErrand() !== null);
}

/** Whether the player is narrow enough for its one-panel composition. Read in
 * the player's components instead of the window's width: a docked column on a
 * wide screen is as narrow as a phone. The surface measures itself and sets
 * this (PlayerSurface). */
export const playerCompact = compact;
export const setPlayerCompact = setCompact;
