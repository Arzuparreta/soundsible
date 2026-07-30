import type { DjDirection } from './api';

/**
 * "Put this on" — the verbs a listener actually uses, in the four languages the
 * player speaks. Anchored at the start, because a name only counts when the
 * phrase *opens* by asking for it; "sounds like oliver heldens" is a remark, not
 * a request.
 */
const PLAY_VERB = /^\s*(?:pon(?:me|edme|ed)?|[ée]chame|dame|mete(?:me)?|quiero(?:\s+(?:escuchar|o[íi]r))?|play|put\s+on|gimme|give\s+me|i\s+want(?:\s+to\s+hear)?|let'?s\s+hear|mets(?:[-\s]moi)?|joue|passe)\b[\s,:]+(.+)$/i;
/** The same, for scripts where word boundaries do not apply. */
const PLAY_VERB_CJK = /^\s*(?:放|播放|来点|我想听)\s*(.+)$/;
/** A request can also name its target directly: "música de Bad Bunny". */
const NAMED_REQUEST = /^\s*(?:m[úu]sica|temas?|canciones|tracks?|songs?|music|morceaux|chansons)\s+(?:de|del|by|du|d[eu]s?)\s+(.+)$/i;

/**
 * "pon algo de funk" is a flavour, not a name — the existing direction parser
 * already reads it as a destination. Only the bare forms name someone.
 */
const FLAVOUR_PREFIX = /^(?:algo|un\s+poco|una?\s+pizca|a\s+bit|a\s+little|some|something|un\s+peu)\b/i;
/** "música de X", "songs by X" — filler that still points at a name. */
const NAMED_BY = /^(?:m[úu]sica|temas?|canciones|cosas|alg[úu]n\s+tema|tracks?|songs?|music|morceaux|chansons)\s+(?:de|del|by|du|d[eu]s?)\s+/i;
/** Where an instruction stops naming and starts steering. */
const TAIL = /\s+(?:pero|aunque|but|mais|however)\b.*$/i;

/**
 * The artist or track a listener asked for out loud, or null.
 *
 * Deliberately shallow: it decides whether a phrase *is* a request and hands
 * over the words. Whether those words name anything real is the catalogue's
 * question, not a regex's — which is also why a phrase that turns out to name
 * nothing can still be applied as a direction.
 */
export function parseNamedRequest(prompt: string): string | null {
  const match = PLAY_VERB.exec(prompt) ?? PLAY_VERB_CJK.exec(prompt) ?? NAMED_REQUEST.exec(prompt);
  if (!match) return null;
  let name = match[1].replace(TAIL, '').split(/[,.;·]/)[0].trim();
  if (FLAVOUR_PREFIX.test(name)) return null;
  name = name.replace(NAMED_BY, '').trim();
  // A bare verb, or so long it is a sentence rather than a name.
  return name.length >= 2 && name.length <= 80 ? name : null;
}

const ENERGY_UP = /(?:sube|arriba|caña|intens|energ|bailable|rápid|rapid|more\s+(?:energy|energetic)|harder|faster|plus\s+(?:d['’]énergie|fort|rapide)|更有活力|更快)/i;
const ENERGY_DOWN = /(?:baja|menos|calma|suave|tranquil|relaj|softer|calmer|slower|doucement|calme|moins\s+(?:fort|rapide)|柔和|平静|慢一点)/i;
const FAMILIAR = /(?:conocid|familiar|clásic|clasic|hits?|known|classics?|familier|classiques?|熟悉|经典)/i;
const UNFAMILIAR = /(?:descubr|nuevo|sorpr|explor|arriesg|discover|new|surprise|deep\s+cuts?|découvr|nouve|surpr|探索|新歌|冷门)/i;

/**
 * Resolve opposing words as one movement. The lowering vocabulary wins when
 * both appear: "más suave" contains "más", but its actual instruction is down.
 */
function polarity(text: string, up: RegExp, down: RegExp): -1 | 0 | 1 {
  if (down.test(text)) return -1;
  if (up.test(text)) return 1;
  return 0;
}

function clampDirection(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

/** Turn a short natural instruction into the same controls exposed as chips.
 * The original prompt is retained for future ranking improvements; known
 * intent is applied immediately and deterministically. */
export function parseDjDirection(prompt: string, current: DjDirection): DjDirection {
  const text = prompt.trim();
  const normalized = text.toLocaleLowerCase();
  const energy = clampDirection(current.energy + 0.35 * polarity(normalized, ENERGY_UP, ENERGY_DOWN));
  const familiarity = clampDirection(current.familiarity + 0.35 * polarity(normalized, FAMILIAR, UNFAMILIAR));
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
