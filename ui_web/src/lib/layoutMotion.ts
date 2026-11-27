import { prefersReducedMotion } from './prefersReducedMotion';

export function captureLayoutRects(elements: Iterable<HTMLElement>): Map<Element, DOMRect> {
  return new Map(Array.from(elements, (element) => [element, element.getBoundingClientRect()]));
}

export function animateLayoutRects(
  before: Map<Element, DOMRect>,
  elements: () => Iterable<HTMLElement>,
) {
  if (prefersReducedMotion()) return;
  requestAnimationFrame(() => {
    for (const element of elements()) {
      const first = before.get(element);
      const last = element.getBoundingClientRect();
      if (!first || !last.width || !last.height) continue;
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      const sx = first.width / last.width;
      const sy = first.height / last.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
      element.animate(
        [
          { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
          { transformOrigin: 'top left', transform: 'none' },
        ],
        { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    }
  });
}
