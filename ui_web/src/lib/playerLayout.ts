export interface PlayerPanelLayout<PanelId extends string> {
  version: 1;
  fitArtwork?: boolean;
  order: PanelId[];
  ratios: Record<PanelId, number>;
}

export function clonePanelLayout<PanelId extends string>(
  layout: PlayerPanelLayout<PanelId>,
): PlayerPanelLayout<PanelId> {
  return {
    ...layout,
    order: [...layout.order],
    ratios: { ...layout.ratios },
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
        const inDefaultOrder = parsed.order.every((id, index) => id === fallback.order[index]);
        const oldDefault = ids.every((id) => Math.abs(ratios[id] - fallback.ratios[id]) < 1e-6);
        const equalShares = ids.every((id) => Math.abs(ratios[id] - 1 / ids.length) < 1e-6);
        // Older defaults were persisted as ratios. Keep other saved layouts.
        if (parsed.fitArtwork === undefined && inDefaultOrder && (oldDefault || equalShares)) return clonePanelLayout(fallback);
        return {
          version: 1,
          ...(typeof parsed.fitArtwork === 'boolean' ? { fitArtwork: parsed.fitArtwork } : {}),
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
