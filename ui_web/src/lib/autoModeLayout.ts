import {
  buildThreePanelLayoutPresets,
  clonePanelLayout,
  parsePanelLayout,
  type PlayerPanelLayout,
  type ThreePanelLayoutPresetId,
} from './playerLayout';

export type AutoModePanelId = 'browser' | 'stage' | 'route';
export type AutoModeDesktopLayout = PlayerPanelLayout<AutoModePanelId>;
export type AutoModeLayoutPresetId = ThreePanelLayoutPresetId;

export const AUTO_MODE_LAYOUT_KEY = 'auto:desktopLayout:v2';
export const AUTO_MODE_PANELS: readonly AutoModePanelId[] = ['browser', 'stage', 'route'];
export const DEFAULT_AUTO_MODE_LAYOUT: AutoModeDesktopLayout = {
  version: 1,
  order: ['browser', 'stage', 'route'],
  // The stage takes the wider middle, the panel whose artwork grows with the
  // room; at 36 percent a 1536x864 window's cover is already as tall as the
  // window allows, and the lists keep the width their titles need.
  ratios: { browser: 0.32, stage: 0.36, route: 0.32 },
};
export const AUTO_MODE_LAYOUT_PRESETS = buildThreePanelLayoutPresets(
  { left: 'browser', stage: 'stage', right: 'route' } as const,
  DEFAULT_AUTO_MODE_LAYOUT.ratios,
);

function isPanelId(value: unknown): value is AutoModePanelId {
  return value === 'browser' || value === 'stage' || value === 'route';
}

export function parseAutoModeLayout(raw: string | null): AutoModeDesktopLayout {
  return parsePanelLayout(raw, AUTO_MODE_PANELS, DEFAULT_AUTO_MODE_LAYOUT, isPanelId);
}

export function cloneAutoModeLayout(
  layout: AutoModeDesktopLayout = DEFAULT_AUTO_MODE_LAYOUT,
): AutoModeDesktopLayout {
  return clonePanelLayout(layout);
}

export function autoModeLayoutFromPreset(
  preset: AutoModeLayoutPresetId,
): AutoModeDesktopLayout {
  return clonePanelLayout(AUTO_MODE_LAYOUT_PRESETS[preset]);
}
