/** Continuity of a media renderer, independent of musical tempo confidence.
 * Integrate the requested speed: repeated small backwards steps and a clock
 * that creeps forward can be broken even without a `waiting` event. */
export class MediaClockHealth {
  private previous?: { at: number; position: number; rate: number };
  private started = 0;
  private origin = 0;
  private expected = 0;
  private highWater = 0;
  private deficientWindows = 0;

  reset(): void { this.previous = undefined; this.deficientWindows = 0; }

  observe(deck: Pick<HTMLMediaElement, 'currentTime' | 'playbackRate' | 'paused' | 'seeking' | 'readyState'>,
    now = performance.now()): 'clock_regressed' | 'clock_starved' | null {
    const position = deck.currentTime;
    const before = this.previous;
    if (deck.paused || deck.seeking || deck.readyState < 3 || !Number.isFinite(position)) {
      this.reset();
      return null;
    }
    if (!before || now - before.at > 2000 || now < before.at) {
      this.started = now;
      this.origin = position;
      this.expected = 0;
      this.highWater = position;
      this.deficientWindows = 0;
    } else {
      this.expected += (now - before.at) / 1000 * before.rate;
      if (position < this.highWater - 0.05) { this.reset(); return 'clock_regressed'; }
      this.highWater = Math.max(this.highWater, position);
      if (now - this.started >= 1000) {
        // A start/seek can leave a fixed offset while subsequent progress is
        // healthy. Confirm loss of progress in two consecutive complete windows
        // instead of interrupting the renderer on that one transient deficit.
        const starved = this.expected - (position - this.origin) > 0.25;
        this.deficientWindows = starved ? this.deficientWindows + 1 : 0;
        this.started = now;
        this.origin = position;
        this.expected = 0;
        if (this.deficientWindows >= 2) { this.reset(); return 'clock_starved'; }
      }
    }
    this.previous = { at: now, position, rate: deck.playbackRate };
    return null;
  }
}
