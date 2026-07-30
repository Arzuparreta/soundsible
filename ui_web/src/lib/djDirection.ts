import type { DjDirection } from './api';

/** Turn a short natural instruction into the same controls exposed as chips.
 * The original prompt is retained for future ranking improvements; known
 * intent is applied immediately and deterministically. */
export function parseDjDirection(prompt: string, current: DjDirection): DjDirection {
  const text = prompt.trim();
  const normalized = text.toLocaleLowerCase();
  let energy = current.energy;
  let familiarity = current.familiarity;
  if (/(sube|más|mas|arriba|caña|intens|energ|bailable|rápid|rapid)/.test(normalized)) {
    energy = Math.min(1, energy + 0.35);
  }
  if (/(baja|menos|calma|suave|tranquil|relaj)/.test(normalized)) {
    energy = Math.max(-1, energy - 0.35);
  }
  if (/(conocid|familiar|clásic|clasic|hits?)/.test(normalized)) {
    familiarity = Math.min(1, familiarity + 0.35);
  }
  if (/(descubr|nuevo|sorpr|explor|arriesg)/.test(normalized)) {
    familiarity = Math.max(-1, familiarity - 0.35);
  }
  const avoid = normalized.match(/(?:evita|sin|no pongas?)\s+([^,.;]+)/);
  const toward = normalized.match(
    /(?:hacia|tira a|pon algo de|más de|mas de)\s+(.+?)(?=\s+(?:sin|evita|pero no)|[,.;]|$)/,
  );
  return {
    ...current,
    energy,
    familiarity,
    prompt: text,
    include: toward?.[1] ? [toward[1].trim()] : current.include,
    exclude: avoid?.[1] ? [avoid[1].trim()] : current.exclude,
  };
}
