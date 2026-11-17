/**
 * jsdom lays nothing out: every element measures 0×0, and a bounded collection
 * with no viewport renders no rows. Tests that render one call this to give
 * elements the size the virtualizer measures.
 */
export function mockScrollportLayout(width = 400, height = 600): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => height });
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
  }
}
