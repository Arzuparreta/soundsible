export type NowPlayingPanelId = 'browser' | 'stage' | 'queue';

export interface NowPlayingDesktopLayout {
  version: 1;
  order: NowPlayingPanelId[];
  ratios: Record<NowPlayingPanelId, number>;
}

export type NowPlayingLayoutPresetId = 'balanced' | 'player' | 'explore' | 'queue';

export const NOW_PLAYING_LAYOUT_KEY = 'np:desktopLayout:v1';
export const DEFAULT_NOW_PLAYING_LAYOUT: NowPlayingDesktopLayout = {
  version: 1,
  order: ['browser', 'stage', 'queue'],
  ratios: { browser: 0.25, stage: 0.5, queue: 0.25 },
};

export const NOW_PLAYING_LAYOUT_PRESETS: Record<NowPlayingLayoutPresetId, NowPlayingDesktopLayout> = {
  balanced: DEFAULT_NOW_PLAYING_LAYOUT,
  player: {
    version: 1,
    order: ['browser', 'stage', 'queue'],
    ratios: { browser: 0.2, stage: 0.6, queue: 0.2 },
  },
  explore: {
    version: 1,
    order: ['stage', 'browser', 'queue'],
    ratios: { browser: 0.5, stage: 0.3, queue: 0.2 },
  },
  queue: {
    version: 1,
    order: ['browser', 'queue', 'stage'],
    ratios: { browser: 0.2, stage: 0.3, queue: 0.5 },
  },
};

const IDS: NowPlayingPanelId[] = ['browser', 'stage', 'queue'];

export function layoutFromPreset(preset: NowPlayingLayoutPresetId): NowPlayingDesktopLayout {
  const layout = NOW_PLAYING_LAYOUT_PRESETS[preset];
  return {
    ...layout,
    order: [...layout.order],
    ratios: { ...layout.ratios },
  };
}

function isPanelId(value: unknown): value is NowPlayingPanelId {
  return value === 'browser' || value === 'stage' || value === 'queue';
}

export function normalizePanelRatios(
  ratios: Partial<Record<NowPlayingPanelId, number>>,
): Record<NowPlayingPanelId, number> {
  const safe = Object.fromEntries(
    IDS.map((id) => [id, Number.isFinite(ratios[id]) && Number(ratios[id]) > 0 ? Number(ratios[id]) : DEFAULT_NOW_PLAYING_LAYOUT.ratios[id]]),
  ) as Record<NowPlayingPanelId, number>;
  const total = IDS.reduce((sum, id) => sum + safe[id], 0);
  return Object.fromEntries(IDS.map((id) => [id, safe[id] / total])) as Record<NowPlayingPanelId, number>;
}

export function parseNowPlayingLayout(raw: string | null, legacySide?: string | null): NowPlayingDesktopLayout {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<NowPlayingDesktopLayout>;
      if (
        parsed.version === 1
        && Array.isArray(parsed.order)
        && parsed.order.length === 3
        && parsed.order.every(isPanelId)
        && new Set(parsed.order).size === 3
        && parsed.ratios
      ) {
        return {
          version: 1,
          order: [...parsed.order],
          ratios: normalizePanelRatios(parsed.ratios),
        };
      }
    } catch {
      /* fall through to the safe migration/default */
    }
  }
  return legacySide === 'right'
    ? { ...DEFAULT_NOW_PLAYING_LAYOUT, order: ['stage', 'queue', 'browser'] }
    : { ...DEFAULT_NOW_PLAYING_LAYOUT, order: [...DEFAULT_NOW_PLAYING_LAYOUT.order] };
}

export function movePanel(
  order: NowPlayingPanelId[],
  panel: NowPlayingPanelId,
  direction: -1 | 1,
): NowPlayingPanelId[] {
  const from = order.indexOf(panel);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function reorderPanel(
  order: NowPlayingPanelId[],
  panel: NowPlayingPanelId,
  targetIndex: number,
): NowPlayingPanelId[] {
  const next = order.filter((id) => id !== panel);
  next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, panel);
  return next;
}

export function resizeAdjacentPanels(
  ratios: Record<NowPlayingPanelId, number>,
  left: NowPlayingPanelId,
  right: NowPlayingPanelId,
  deltaRatio: number,
  minRatios: Partial<Record<NowPlayingPanelId, number>> = {},
): Record<NowPlayingPanelId, number> {
  const pair = ratios[left] + ratios[right];
  const leftMin = minRatios[left] ?? 0.08;
  const rightMin = minRatios[right] ?? 0.08;
  const nextLeft = Math.max(leftMin, Math.min(pair - rightMin, ratios[left] + deltaRatio));
  return normalizePanelRatios({
    ...ratios,
    [left]: nextLeft,
    [right]: pair - nextLeft,
  });
}
