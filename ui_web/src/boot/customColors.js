// @ts-check
// Also inlined in the startup document. Keep this module independent of the UI.

// Keep one atomic preference for the two seeds. The existing "theme" key
// continues to select System, Light or Dark, or to opt into these colors.
export const CUSTOM_COLORS_KEY = 'soundsible:custom-colors';
export const DEFAULT_CUSTOM_COLORS = Object.freeze({ canvas: '#172335', accent: '#78dcca' });

/** @param {unknown} input */
export function normalizeHex(input) {
  if (typeof input !== 'string') return null;
  const hex = input.trim().toLowerCase();
  if (/^#?[0-9a-f]{6}$/.test(hex)) return '#' + hex.replace('#', '');
  if (/^#?[0-9a-f]{3}$/.test(hex)) return '#' + [...hex.replace('#', '')].map(digit => digit.repeat(2)).join('');
  return null;
}

/** @param {unknown} input */
export function parseCustomColors(input) {
  if (!input || typeof input !== 'object') return null;
  const { canvas, accent } = /** @type {{ canvas?: unknown, accent?: unknown }} */ (input);
  const validCanvas = normalizeHex(canvas);
  const validAccent = normalizeHex(accent);
  return validCanvas && validAccent ? { canvas: validCanvas, accent: validAccent } : null;
}

export function readCustomColors() {
  try {
    return parseCustomColors(JSON.parse(localStorage.getItem(CUSTOM_COLORS_KEY) ?? 'null')) ?? DEFAULT_CUSTOM_COLORS;
  } catch {
    return DEFAULT_CUSTOM_COLORS;
  }
}

/** @param {string} hex */
function channels(hex) {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
}

/** @param {string} color @param {string} toward @param {number} amount */
function blend(color, toward, amount) {
  const end = channels(toward);
  return '#' + channels(color)
    .map((start, i) => Math.round(start + (end[i] - start) * amount).toString(16).padStart(2, '0'))
    .join('');
}

/** @param {string} color */
export function luminance(color) {
  const [r, g, b] = channels(color).map(value => value / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** @param {string} first @param {string} second */
export function contrast(first, second) {
  const a = luminance(first) + 0.05;
  const b = luminance(second) + 0.05;
  return Math.max(a, b) / Math.min(a, b);
}

/** Find the first accessible shade along the seed-to-ink ramp.
 * @param {string} seed @param {string} toward @param {(color: string) => boolean} fits */
function shade(seed, toward, fits) {
  if (fits(seed)) return seed;
  let low = 0;
  let high = 1;
  let result = toward;
  for (let step = 0; step < 10; step++) {
    const middle = (low + high) / 2;
    const candidate = blend(seed, toward, middle);
    if (fits(candidate)) {
      result = candidate;
      high = middle;
    } else {
      low = middle;
    }
  }
  return result;
}

/**
 * Use the canvas hue all the way through the material ramp. The canvas is
 * moved toward its light/dark pole only when it has too little headroom for
 * the lightest/darkest material, including artwork showing through the veil.
 *
 * @param {{ canvas: string, accent: string }} seeds normalized by parseCustomColors
 */
export function deriveCustomColors({ canvas, accent }) {
  const dark = luminance(canvas) < 0.179;
  const paper = dark ? '#000000' : '#ffffff';
  const ink = dark ? '#ffffff' : '#000000';
  const edge = (/** @type {string} */ color) => blend(color, ink, 0.20);
  const base = shade(canvas, paper, value => contrast(edge(value), ink) >= 7.5);
  const surface = (/** @type {number} */ amount) => blend(base, ink, amount);
  const boundary = edge(base);
  const readable = (/** @type {string} */ color, ratio = 5) =>
    shade(color, ink, value => contrast(value, boundary) >= ratio &&
      (dark ? luminance(value) > luminance(boundary) : luminance(value) < luminance(boundary)));
  const fill = (/** @type {string} */ color) => shade(color, ink, value =>
    contrast(value, boundary) >= 3 && contrast(value, paper) >= 4.55 &&
    (dark ? luminance(value) > luminance(boundary) : luminance(value) < luminance(boundary)));
  const accentFill = fill(accent);
  const danger = readable(dark ? '#ff857d' : '#aa251b');
  return {
    scheme: /** @type {'dark' | 'light'} */ (dark ? 'dark' : 'light'),
    tokens: {
      'bg-base': base,
      'bg-raised': surface(0.035),
      'bg-elevated': surface(0.06),
      'bg-inset': blend(base, paper, 0.12),
      'bg-hover': surface(0.085),
      'bg-active': surface(0.11),
      'hairline': surface(0.22),
      'hairline-strong': readable(surface(0.22), 3.15),
      'ink-primary': ink,
      'ink-secondary': readable(surface(0.55), 6),
      'ink-tertiary': readable(surface(0.43)),
      'ink-on-accent': paper,
      'accent': accentFill,
      'accent-hover': blend(accentFill, ink, 0.12),
      'accent-press': fill(blend(accentFill, base, 0.10)),
      'accent-ink': readable(accent),
      'accent-ink-hover': blend(readable(accent), ink, 0.12),
      'selection-bg': surface(0.20),
      'info': readable(dark ? '#78b6ff' : '#235b9e'),
      'success': readable(dark ? '#73db94' : '#156534'),
      'warning': readable(dark ? '#f5cf76' : '#765000'),
      'danger': danger,
      'ink-on-danger': paper,
    },
  };
}

/** @param {ReturnType<typeof deriveCustomColors> | null} palette */
export function stampCustomColors(palette) {
  const root = document.documentElement;
  if (palette) {
    for (const [name, value] of Object.entries(palette.tokens)) {
      root.style.setProperty('--custom-' + name, value);
    }
    root.dataset.customColors = '';
  } else if (root.hasAttribute('data-custom-colors')) {
    for (const name of Array.from(root.style)) {
      if (name.startsWith('--custom-')) root.style.removeProperty(name);
    }
    delete root.dataset.customColors;
  }
}
