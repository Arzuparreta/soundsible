import {
  buildThreePanelLayoutPresets,
  clonePanelLayout,
  movePanel as movePlayerPanel,
  normalizePanelRatios as normalizePlayerPanelRatios,
  parsePanelLayout,
  reorderPanel as reorderPlayerPanel,
  resizeAdjacentPanels as resizePlayerPanels,
  type PlayerPanelLayout,
  type ThreePanelLayoutPresetId,
} from './playerLayout';

export type NowPlayingPanelId = 'browser' | 'stage' | 'queue';
export type NowPlayingDesktopLayout = PlayerPanelLayout<NowPlayingPanelId>;

export type NowPlayingLayoutPresetId = ThreePanelLayoutPresetId;

export const NOW_PLAYING_LAYOUT_KEY = 'np:desktopLayout:v1';
export const DEFAULT_NOW_PLAYING_LAYOUT: NowPlayingDesktopLayout = {
  version: 1,
  order: ['browser', 'stage', 'queue'],
  ratios: { browser: 1 / 3, stage: 1 / 3, queue: 1 / 3 },
};

export const NOW_PLAYING_LAYOUT_PRESETS = buildThreePanelLayoutPresets(
  { left: 'browser', stage: 'stage', right: 'queue' } as const,
  DEFAULT_NOW_PLAYING_LAYOUT.ratios,
);

const IDS: NowPlayingPanelId[] = ['browser', 'stage', 'queue'];

export function layoutFromPreset(preset: NowPlayingLayoutPresetId): NowPlayingDesktopLayout {
  return clonePanelLayout(NOW_PLAYING_LAYOUT_PRESETS[preset]);
}

function isPanelId(value: unknown): value is NowPlayingPanelId {
  return value === 'browser' || value === 'stage' || value === 'queue';
}

export function normalizePanelRatios(
  ratios: Partial<Record<NowPlayingPanelId, number>>,
): Record<NowPlayingPanelId, number> {
  return normalizePlayerPanelRatios(IDS, ratios, DEFAULT_NOW_PLAYING_LAYOUT.ratios);
}

export function parseNowPlayingLayout(raw: string | null, legacySide?: string | null): NowPlayingDesktopLayout {
  const fallback: NowPlayingDesktopLayout = legacySide === 'right'
    ? { ...DEFAULT_NOW_PLAYING_LAYOUT, order: ['stage', 'queue', 'browser'] }
    : DEFAULT_NOW_PLAYING_LAYOUT;
  return parsePanelLayout(raw, IDS, fallback, isPanelId);
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
  return resizePlayerPanels(
    IDS,
    ratios,
    DEFAULT_NOW_PLAYING_LAYOUT.ratios,
    left,
    right,
    deltaRatio,
    minRatios,
  );
}
