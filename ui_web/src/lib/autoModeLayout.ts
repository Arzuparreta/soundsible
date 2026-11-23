import {
  clonePanelLayout,
  parsePanelLayout,
  type PlayerPanelLayout,
} from './playerLayout';

export type AutoModePanelId = 'stage' | 'route';
export type AutoModeDesktopLayout = PlayerPanelLayout<AutoModePanelId>;

export const AUTO_MODE_LAYOUT_KEY = 'auto:desktopLayout:v2';
export const AUTO_MODE_PANELS: readonly AutoModePanelId[] = ['stage', 'route'];
export const DEFAULT_AUTO_MODE_LAYOUT: AutoModeDesktopLayout = {
  version: 1,
  order: ['stage', 'route'],
  fitArtwork: true,
  ratios: { stage: 0.55, route: 0.45 },
};
function isPanelId(value: unknown): value is AutoModePanelId {
  return value === 'stage' || value === 'route';
}

/** A layout saved with the music browser panel the player used to have no
 * longer fits its two panels, and falls back to the default. */
export function parseAutoModeLayout(raw: string | null): AutoModeDesktopLayout {
  return parsePanelLayout(raw, AUTO_MODE_PANELS, DEFAULT_AUTO_MODE_LAYOUT, isPanelId);
}

export function cloneAutoModeLayout(
  layout: AutoModeDesktopLayout = DEFAULT_AUTO_MODE_LAYOUT,
): AutoModeDesktopLayout {
  return clonePanelLayout(layout);
}
