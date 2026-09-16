import { normalizeLibraryQuery } from './librarySearch';

/**
 * The matcher behind the settings search. Pure and generic: it ranks whatever
 * documents it is handed, and knows nothing about sections or i18n.
 *
 * What makes it forgiving, in the order it tries things:
 * - every word of the query must match, in any order ("volume level" finds
 *   "Level volume across tracks");
 * - a whole word beats the start of a word, which beats the inside of one;
 * - a typo still lands (one edit up to six letters, two beyond);
 * - short filler words that match nothing ("the", "de") are ignored;
 * - Han text has no spaces, so any fragment of it counts.
 * Lower scores are better. Field weights push synonyms and notes below labels.
 */

export interface SearchField {
  text: string;
  /** Added to every match in this field. The label itself is 0. */
  weight: number;
}

export interface SearchDoc<T> {
  value: T;
  /** The text a result shows. Matched at weight 0 and used for highlighting. */
  label: string;
  fields: SearchField[];
}

/** `[start, end)` in the original label's UTF-16 indices. */
export type MatchRange = [number, number];

export interface SearchHit<T> {
  value: T;
  score: number;
  ranges: MatchRange[];
}

const EXACT = 0;
const WORD_PREFIX = 1;
const INSIDE_WORD = 3;
const TYPO = 5;
/** What a short filler word costs, matched or not. */
const FILLER = 2;
/** Fields this far down are prose; typo matching there only adds noise. */
const NO_TYPOS_FROM_WEIGHT = 6;

const HAN = /\p{Script=Han}/u;
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

function words(normalized: string): string[] {
  return normalized.split(WORD_SPLIT).filter(Boolean);
}

/** Optimal string alignment distance; anything beyond `max` reads as `max + 1`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) rows.push([i]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, rows[i - 2][j - 2] + 1);
      }
      rows[i][j] = value;
    }
  }
  return Math.min(rows[a.length][b.length], max + 1);
}

function typoBudget(token: string): number {
  if (token.length < 4 || HAN.test(token)) return 0;
  return token.length >= 7 ? 2 : 1;
}

interface PreparedField {
  weight: number;
  normalized: string;
  words: string[];
}

function prepare(field: SearchField): PreparedField {
  const normalized = normalizeLibraryQuery(field.text);
  return { weight: field.weight, normalized, words: words(normalized) };
}

/** How well one query word matches one field, before the field's weight. */
function tokenScore(token: string, field: PreparedField, typos: boolean): number | null {
  let best: number | null = null;
  for (const word of field.words) {
    if (word === token) return EXACT;
    if (word.startsWith(token)) best = WORD_PREFIX;
  }
  if (best != null) return best;
  if ((token.length >= 3 || HAN.test(token)) && field.normalized.includes(token)) return INSIDE_WORD;

  const budget = typos ? typoBudget(token) : 0;
  if (budget === 0) return null;
  let closest = budget + 1;
  for (const word of field.words) {
    if (word.length < 3) continue;
    closest = Math.min(closest, editDistance(token, word, budget));
    // Still typing: compare against the start of a longer word too.
    if (word.length > token.length) {
      closest = Math.min(closest, editDistance(token, word.slice(0, token.length), budget));
    }
    if (closest === 1) break;
  }
  return closest <= budget ? TYPO + closest : null;
}

function isFiller(token: string): boolean {
  return token.length <= 2 && !HAN.test(token);
}

/**
 * Rank `docs` against `query`. `null` means there is nothing to search for; an
 * empty array means the query matched nothing. Ties keep the documents' order.
 */
export function rankDocs<T>(docs: SearchDoc<T>[], query: string, limit = 40): SearchHit<T>[] | null {
  const normalizedQuery = normalizeLibraryQuery(query);
  const tokens = words(normalizedQuery);
  if (tokens.length === 0) return null;
  // Filler is only skippable next to a word that carries the query.
  const skippable = tokens.some((token) => !isFiller(token));

  const hits: Array<SearchHit<T> & { order: number }> = [];
  docs.forEach((doc, order) => {
    const label = prepare({ text: doc.label, weight: 0 });
    const fields = [label, ...doc.fields.map(prepare)];
    let total = 0;
    const found: string[] = [];
    for (const token of tokens) {
      let best: number | null = null;
      for (const field of fields) {
        const score = tokenScore(token, field, field.weight < NO_TYPOS_FROM_WEIGHT);
        if (score == null) continue;
        const weighted = score + field.weight;
        if (best == null || weighted < best) best = weighted;
      }
      if (skippable && isFiller(token)) {
        // A filler word never decides the ranking, matched or not.
        total += Math.min(best ?? FILLER, FILLER);
        if (best != null) found.push(token);
        continue;
      }
      if (best == null) return;
      total += best;
      found.push(token);
    }
    if (found.length === 0) return;
    if (label.normalized === normalizedQuery) total -= 3;
    else if (label.normalized.startsWith(normalizedQuery)) total -= 2;
    hits.push({ value: doc.value, score: total, ranges: highlightRanges(doc.label, found), order });
  });

  return hits
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, limit)
    .map(({ value, score, ranges }) => ({ value, score, ranges }));
}

/**
 * Fold `text` the way `normalizeLibraryQuery` does, one character at a time, so
 * every folded index knows where it came from in the original.
 */
function foldWithMap(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const char of text) {
    const piece = char.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
    for (let k = 0; k < piece.length; k += 1) {
      starts.push(index);
      ends.push(index + char.length);
    }
    folded += piece;
    index += char.length;
  }
  return { folded, starts, ends };
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[\p{L}\p{N}]/u.test(char);
}

/**
 * Where the matched words sit in the label, in original indices. A word that
 * only matched a synonym or a typo has nowhere to point, and gets nothing.
 */
export function highlightRanges(label: string, tokens: string[]): MatchRange[] {
  const { folded, starts, ends } = foldWithMap(label);
  const spans: MatchRange[] = [];
  for (const token of tokens) {
    // Prefer the start of a word. Only a fragment long enough to have matched
    // inside a word may be highlighted inside one.
    const inside = token.length >= 3 || HAN.test(token);
    let at = -1;
    for (let from = folded.indexOf(token); from !== -1; from = folded.indexOf(token, from + 1)) {
      if (!isWordChar(folded[from - 1])) {
        at = from;
        break;
      }
      if (at === -1 && inside) at = from;
    }
    if (at === -1) continue;
    spans.push([starts[at], ends[at + token.length - 1]]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: MatchRange[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}
