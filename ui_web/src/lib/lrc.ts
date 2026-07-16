/** Minimal LRC parser: turns "[mm:ss.xx] line" lyrics into timed lines. */

export interface LyricLine {
  /** Seconds from the start of the track. */
  time: number;
  text: string;
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

/** Index of the line currently being sung, or -1 before the first line. */
export function activeLineIndex(lines: LyricLine[], positionSec: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= positionSec) idx = i;
    else break;
  }
  return idx;
}
