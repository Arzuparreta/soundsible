export interface PlayerPanelLayout<PanelId extends string> {
  version: 1;
  order: PanelId[];
  ratios: Record<PanelId, number>;
}

/** The full-screen player's two panels: the stage and its list (the queue,
 * or the DJ route). `stage` gives the stage the room, `list` the list. */
export type TwoPanelLayoutPresetId = 'balanced' | 'stage' | 'list';

export function clonePanelLayout<PanelId extends string>(
  layout: PlayerPanelLayout<PanelId>,
): PlayerPanelLayout<PanelId> {
  return {
    version: 1,
    order: [...layout.order],
    ratios: { ...layout.ratios },
  };
}

export function buildTwoPanelLayoutPresets<PanelId extends string>(
  ids: { stage: PanelId; list: PanelId },
  balancedRatios: Record<PanelId, number>,
): Record<TwoPanelLayoutPresetId, PlayerPanelLayout<PanelId>> {
  const layout = (stage: number): PlayerPanelLayout<PanelId> => ({
    version: 1,
    order: [ids.stage, ids.list],
    ratios: { ...balancedRatios, [ids.stage]: stage, [ids.list]: Math.round((1 - stage) * 100) / 100 },
  });
  return {
    balanced: { version: 1, order: [ids.stage, ids.list], ratios: { ...balancedRatios } },
    stage: layout(0.7),
    list: layout(0.4),
  };
}

export function normalizePanelRatios<PanelId extends string>(
  ids: readonly PanelId[],
  ratios: Partial<Record<PanelId, number>>,
  defaults: Record<PanelId, number>,
): Record<PanelId, number> {
  const safe = Object.fromEntries(
    ids.map((id) => [
      id,
      Number.isFinite(ratios[id]) && Number(ratios[id]) > 0
        ? Number(ratios[id])
        : defaults[id],
    ]),
  ) as Record<PanelId, number>;
  const total = ids.reduce((sum, id) => sum + safe[id], 0);
  return Object.fromEntries(ids.map((id) => [id, safe[id] / total])) as Record<PanelId, number>;
}

export function parsePanelLayout<PanelId extends string>(
  raw: string | null,
  ids: readonly PanelId[],
  fallback: PlayerPanelLayout<PanelId>,
  isPanelId: (value: unknown) => value is PanelId,
): PlayerPanelLayout<PanelId> {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PlayerPanelLayout<PanelId>>;
      if (
        parsed.version === 1
        && Array.isArray(parsed.order)
        && parsed.order.length === ids.length
        && parsed.order.every(isPanelId)
        && new Set(parsed.order).size === ids.length
        && parsed.ratios
      ) {
        const ratios = normalizePanelRatios(ids, parsed.ratios, fallback.ratios);
        // Three equal thirds in the default order is the layout the player
        // shipped with before the stage was given the wider middle, saved by
        // nobody's choice: it follows the default rather than pinning it.
        const untouched = parsed.order.every((id, index) => id === fallback.order[index])
          && ids.every((id) => Math.abs(ratios[id] - 1 / ids.length) < 1e-6);
        if (untouched) return clonePanelLayout(fallback);
        return {
          version: 1,
          order: [...parsed.order],
          ratios,
        };
      }
    } catch {
      /* fall through to the safe default */
    }
  }
  return clonePanelLayout(fallback);
}

export function movePanel<PanelId extends string>(
  order: readonly PanelId[],
  panel: PanelId,
  direction: -1 | 1,
): PanelId[] {
  const from = order.indexOf(panel);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function reorderPanel<PanelId extends string>(
  order: readonly PanelId[],
  panel: PanelId,
  targetIndex: number,
): PanelId[] {
  const next = order.filter((id) => id !== panel);
  next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, panel);
  return next;
}

export function resizeAdjacentPanels<PanelId extends string>(
  ids: readonly PanelId[],
  ratios: Record<PanelId, number>,
  defaults: Record<PanelId, number>,
  left: PanelId,
  right: PanelId,
  deltaRatio: number,
  minRatios: Partial<Record<PanelId, number>> = {},
): Record<PanelId, number> {
  const pair = ratios[left] + ratios[right];
  const leftMin = minRatios[left] ?? 0.08;
  const rightMin = minRatios[right] ?? 0.08;
  const nextLeft = Math.max(leftMin, Math.min(pair - rightMin, ratios[left] + deltaRatio));
  return normalizePanelRatios(ids, {
    ...ratios,
    [left]: nextLeft,
    [right]: pair - nextLeft,
  }, defaults);
}
