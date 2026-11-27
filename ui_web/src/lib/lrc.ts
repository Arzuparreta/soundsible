import type { RichLyricSegment, RichSyncedLyrics } from '../types/music';

/** Minimal LRC parser: turns "[mm:ss.xx] line" lyrics into timed lines. */

export interface LyricLine {
  /** Seconds from the start of the track. */
  time: number;
  text: string;
}

export interface RichWordGroup {
  segments: RichLyricSegment[];
  trailingSpace: boolean;
}

export interface DisplayLyricLine {
  /** Start time in seconds. */
  time: number;
  /** End time in seconds, when provided by rich timing. */
  endTime?: number;
  text: string;
  bg?: boolean;
  words: RichWordGroup[] | null;
}

const STAMP_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    STAMP_RE.lastIndex = 0;
    const stamps: number[] = [];
    let textStart = 0;
    let m: RegExpExecArray | null;
    while ((m = STAMP_RE.exec(raw))) {
      // Only leading stamps count; a bracket mid-line is lyric text.
      if (m.index !== textStart) break;
      const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
      textStart = STAMP_RE.lastIndex;
    }
    if (stamps.length === 0) continue;
    const text = raw.slice(textStart).trim();
    for (const time of stamps) lines.push({ time, text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Group contiguous syllable segments into non-breaking words so the browser
 * never wraps a line in the middle of a multi-syllable word. */
export function groupRichWords(segments: RichLyricSegment[]): RichWordGroup[] {
  const words: RichWordGroup[] = [];
  let current: RichLyricSegment[] = [];
  for (const seg of segments) {
    if (!seg.x) continue;
    const hasLeading = /^\s/.test(seg.x);
    const hasTrailing = /\s$/.test(seg.x);
    const trimmed = seg.x.trim();
    if (hasLeading && current.length > 0) {
      words.push({ segments: current, trailingSpace: true });
      current = [];
    }
    if (trimmed) {
      current.push({ t: seg.t, e: seg.e, x: trimmed });
    }
    if (hasTrailing && current.length > 0) {
      words.push({ segments: current, trailingSpace: true });
      current = [];
    }
  }
  if (current.length > 0) {
    words.push({ segments: current, trailingSpace: false });
  }
  if (words.length > 0) {
    words[words.length - 1].trailingSpace = false;
  }
  return words;
}

/** Convert rich word/syllable timing into display lines shared by LyricsPanelView. */
export function richToDisplayLines(rich: RichSyncedLyrics | null | undefined): DisplayLyricLine[] {
  if (!rich || !Array.isArray(rich.lines) || rich.lines.length === 0) return [];
  const out: DisplayLyricLine[] = [];
  for (const line of rich.lines) {
    if (!line || !Array.isArray(line.s) || line.s.length === 0) continue;
    const words = groupRichWords(line.s);
    const text = words
      .map((word) => word.segments.map((seg) => seg.x).join('') + (word.trailingSpace ? ' ' : ''))
      .join('')
      .trim();
    if (!text) continue;
    out.push({
      time: line.t / 1000,
      endTime: line.e >= line.t ? line.e / 1000 : undefined,
      text,
      bg: Boolean(line.bg),
      words,
    });
  }
  return out;
}

/** Progress ratio in [0, 1] for a single syllable/word segment at `posMs`. */
export function segmentFill(seg: RichLyricSegment, posMs: number): number {
  if (posMs < seg.t) return 0;
  if (posMs >= seg.e || seg.e <= seg.t) return 1;
  return Math.min(1, Math.max(0, (posMs - seg.t) / (seg.e - seg.t)));
}

/** Index of the line currently being sung, or -1 before the first line. */
export function activeLineIndex(lines: Array<{ time: number }>, positionSec: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= positionSec) idx = i;
    else break;
  }
  return idx;
}

/** Seconds a recording may differ from the one its lyrics were timed for
 * (the engine's `TIMING_TOLERANCE_SEC`). */
const TIMING_TOLERANCE_SEC = 3;

/** Whether timed lines can follow a recording of this length. Unknown on
 * either side is not evidence of a mismatch. */
export function timingFits(audioSec: number | null | undefined, syncedSec: number | null | undefined): boolean {
  if (!audioSec || !syncedSec || !Number.isFinite(audioSec) || !Number.isFinite(syncedSec)) return true;
  return Math.abs(audioSec - syncedSec) <= TIMING_TOLERANCE_SEC;
}
