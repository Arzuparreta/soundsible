/** Which way a surface leaves when it is dismissed by hand. */
export type DismissAxis = 'down' | 'left';

/** How far a deliberate drag must travel before it counts as a dismissal. */
const DISTANCE = 72;
/** A short flick dismisses too, if it was fast enough to mean it. */
const FLICK_DISTANCE = 28;
/** px/ms, along the dismiss direction. */
const FLICK_VELOCITY = 0.45;
/**
 * The browser hands the touch to the nearest scroller the moment it sees an
 * unprevented move, and every `preventDefault` after that is a silent no-op.
 * So the first move that clearly reads as a drag has to claim the gesture
 * outright — waiting for a comfortable 8px of slop is already too late.
 */
const ACTIVATE = 2;
/** Travel across the axis that hands the gesture back to whatever owns it. */
const CROSS_CANCEL = 6;
/** How much longer along the axis than across it a drag must be to count. */
const AXIS_BIAS = 1.5;
/* Time a full exit is worth end to end; a partial travel is scaled down from
   it. Under the entrance (--dur-medium, 300ms): leaving reads better a step
   quicker than arriving. */
const EXIT_DURATION = 220;
/** Floor for the last sliver, so a release near the edge still moves visibly. */
const EXIT_DURATION_MIN = 110;

export interface DismissSwipeFrame {
  captured: boolean;
  /** Travel along the dismiss direction, never negative. */
  offset: number;
}

export interface DismissSwipeEnd extends DismissSwipeFrame {
  dismiss: boolean;
  /** px/ms along the dismiss direction at the moment of release. */
  velocity: number;
}

export interface DismissSwipeBegin {
  /** False arms nothing: the surface is not dismissable, or not on a phone. */
  enabled: boolean;
  /** The scroller under the finger has already travelled — it owns the drag. */
  scrolled: boolean;
}

/**
 * Drag-to-dismiss, as arithmetic.
 *
 * A bottom sheet leaves downwards and a left drawer leaves to the left, but
 * the decisions are the same either way: has this drag committed to the axis,
 * how far along it is the surface now, and did the finger let go having meant
 * it. Keeping that here — with no element, no event and no stylesheet — is what
 * makes it testable, and what stops the next surface that wants the gesture
 * from growing a fourth private copy of these thresholds.
 */
export function createDismissSwipe(
  axis: DismissAxis,
  limits: { distance?: number } = {},
) {
  const commitDistance = limits.distance ?? DISTANCE;
  let tracking = false;
  let captured = false;
  let startMain = 0;
  let startCross = 0;
  let startTime = 0;
  let lastMain = 0;
  let lastTime = 0;
  let offset = 0;

  /** Travel along the dismiss direction, and across it, in that order. */
  const project = (x: number, y: number): [number, number] => (
    axis === 'down' ? [y, x] : [-x, y]
  );

  const begin = (x: number, y: number, time: number, opts: DismissSwipeBegin) => {
    const [main, cross] = project(x, y);
    tracking = opts.enabled && !opts.scrolled;
    captured = false;
    startMain = main;
    startCross = cross;
    startTime = time;
    lastMain = main;
    lastTime = time;
    offset = 0;
  };

  const move = (x: number, y: number, time: number): DismissSwipeFrame => {
    if (!tracking) return { captured: false, offset };
    const [main, cross] = project(x, y);
    const travel = main - startMain;
    const drift = Math.abs(cross - startCross);

    if (!captured) {
      if (drift > Math.abs(travel)) {
        // Across the axis: this belongs to whatever is under the finger.
        if (drift > CROSS_CANCEL) tracking = false;
        return { captured: false, offset };
      }
      // Backwards along the axis is somebody else's gesture too — a sheet does
      // not dismiss upwards, and a left drawer does not dismiss rightwards.
      if (travel < -ACTIVATE) {
        tracking = false;
        return { captured: false, offset };
      }
      if (travel <= ACTIVATE || travel <= drift * AXIS_BIAS) return { captured: false, offset };
      captured = true;
    }

    offset = Math.max(0, travel);
    lastMain = main;
    lastTime = time;
    return { captured, offset };
  };

  const end = (time: number): DismissSwipeEnd => {
    const duration = Math.max(1, time - Math.max(startTime, lastTime - 80));
    const velocity = captured ? Math.max(0, (lastMain - startMain) / duration) : 0;
    const dismiss = captured
      && (offset > commitDistance || (offset > FLICK_DISTANCE && velocity > FLICK_VELOCITY));
    const result = { captured, offset, dismiss, velocity };
    tracking = false;
    captured = false;
    return result;
  };

  const cancel = (): DismissSwipeFrame => {
    const wasCaptured = captured;
    tracking = false;
    captured = false;
    offset = 0;
    return { captured: wasCaptured, offset: 0 };
  };

  return { begin, move, end, cancel };
}

/**
 * How the exit should finish the move the finger started.
 *
 * `offset` is where the surface already is and `velocity` the speed it had when
 * the finger left. The exit covers the distance that is actually left, in the
 * time that distance is worth: a sheet released halfway out does not restart a
 * full-height animation, and a flick keeps its speed instead of dropping into a
 * slow settle. The floor is what stops a release near the edge from finishing
 * in a single frame — an exit too short to see is one nobody believes happened.
 */
export function dismissExitTiming(
  offset: number,
  extent: number,
  velocity: number,
): { from: number; duration: number } {
  const span = Math.max(1, extent);
  const from = Math.min(Math.max(0, offset), span);
  const remaining = span - from;
  const paced = velocity > 0 ? remaining / velocity : Number.POSITIVE_INFINITY;
  const scaled = Math.min(EXIT_DURATION * (remaining / span), paced);
  return { from, duration: Math.max(EXIT_DURATION_MIN, Math.round(scaled)) };
}

export const dismissSwipeConstants = {
  DISTANCE,
  FLICK_DISTANCE,
  FLICK_VELOCITY,
  ACTIVATE,
  CROSS_CANCEL,
  AXIS_BIAS,
  EXIT_DURATION,
  EXIT_DURATION_MIN,
} as const;
