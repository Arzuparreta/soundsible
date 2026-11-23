import {
  buildTwoPanelLayoutPresets,
  clonePanelLayout,
  movePanel as movePlayerPanel,
  normalizePanelRatios as normalizePlayerPanelRatios,
  parsePanelLayout,
  reorderPanel as reorderPlayerPanel,
  resizeAdjacentPanels as resizePlayerPanels,
  type PlayerPanelLayout,
  type TwoPanelLayoutPresetId,
} from './playerLayout';

export type NowPlayingPanelId = 'stage' | 'queue';
export type NowPlayingDesktopLayout = PlayerPanelLayout<NowPlayingPanelId>;

export type NowPlayingLayoutPresetId = TwoPanelLayoutPresetId;

export const NOW_PLAYING_LAYOUT_KEY = 'np:desktopLayout:v1';
export const NOW_PLAYING_PANELS: readonly NowPlayingPanelId[] = ['stage', 'queue'];
export const DEFAULT_NOW_PLAYING_LAYOUT: NowPlayingDesktopLayout = {
  version: 1,
  order: ['stage', 'queue'],
  // The stage takes the wider share, the panel whose artwork grows with the
  // room; the queue keeps the width its titles need.
  ratios: { stage: 0.55, queue: 0.45 },
};

export const NOW_PLAYING_LAYOUT_PRESETS = buildTwoPanelLayoutPresets(
  { stage: 'stage', list: 'queue' } as const,
  DEFAULT_NOW_PLAYING_LAYOUT.ratios,
);

export function layoutFromPreset(preset: NowPlayingLayoutPresetId): NowPlayingDesktopLayout {
  return clonePanelLayout(NOW_PLAYING_LAYOUT_PRESETS[preset]);
}

function isPanelId(value: unknown): value is NowPlayingPanelId {
  return value === 'stage' || value === 'queue';
}

export function normalizePanelRatios(
  ratios: Partial<Record<NowPlayingPanelId, number>>,
): Record<NowPlayingPanelId, number> {
  return normalizePlayerPanelRatios(NOW_PLAYING_PANELS, ratios, DEFAULT_NOW_PLAYING_LAYOUT.ratios);
}

/** A layout saved with the music browser panel the player used to have no
 * longer fits its two panels, and falls back to the default. */
export function parseNowPlayingLayout(raw: string | null): NowPlayingDesktopLayout {
  return parsePanelLayout(raw, NOW_PLAYING_PANELS, DEFAULT_NOW_PLAYING_LAYOUT, isPanelId);
}

export function movePanel(
  order: NowPlayingPanelId[],
  panel: NowPlayingPanelId,
  direction: -1 | 1,
): NowPlayingPanelId[] {
  return movePlayerPanel(order, panel, direction);
}

export function reorderPanel(
  order: NowPlayingPanelId[],
  panel: NowPlayingPanelId,
  targetIndex: number,
): NowPlayingPanelId[] {
  return reorderPlayerPanel(order, panel, targetIndex);
}

export function resizeAdjacentPanels(
  ratios: Record<NowPlayingPanelId, number>,
  left: NowPlayingPanelId,
  right: NowPlayingPanelId,
  deltaRatio: number,
  minRatios: Partial<Record<NowPlayingPanelId, number>> = {},
): Record<NowPlayingPanelId, number> {
  return resizePlayerPanels(NOW_PLAYING_PANELS, ratios, DEFAULT_NOW_PLAYING_LAYOUT.ratios, left, right, deltaRatio, minRatios);
}
