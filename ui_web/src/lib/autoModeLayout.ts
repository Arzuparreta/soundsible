import {
  buildThreePanelLayoutPresets,
  clonePanelLayout,
  parsePanelLayout,
  type PlayerPanelLayout,
  type ThreePanelLayoutPresetId,
} from './playerLayout';

export type AutoModePanelId = 'booth' | 'stage' | 'route';
export type AutoModeDesktopLayout = PlayerPanelLayout<AutoModePanelId>;
export type AutoModeLayoutPresetId = ThreePanelLayoutPresetId;

export const AUTO_MODE_LAYOUT_KEY = 'auto:desktopLayout:v1';
export const AUTO_MODE_PANELS: readonly AutoModePanelId[] = ['booth', 'stage', 'route'];
export const DEFAULT_AUTO_MODE_LAYOUT: AutoModeDesktopLayout = {
  version: 1,
  order: ['booth', 'stage', 'route'],
  ratios: { booth: 0.24, stage: 0.52, route: 0.24 },
};
export const AUTO_MODE_LAYOUT_PRESETS = buildThreePanelLayoutPresets(
  { left: 'booth', stage: 'stage', right: 'route' } as const,
  DEFAULT_AUTO_MODE_LAYOUT.ratios,
);

function isPanelId(value: unknown): value is AutoModePanelId {
  return value === 'booth' || value === 'stage' || value === 'route';
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
