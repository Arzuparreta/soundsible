import { render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { VirtualRows } from './VirtualRows';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  // jsdom reports every element as zero-sized, so the virtualizer would decide
  // nothing fits and render an empty list.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
});

function renderRows(count: number) {
  const items = Array.from({ length: count }, (_, i) => ({ id: `t${i}`, title: `Song ${i}` }));
  const [scrollRef, setScrollRef] = createSignal<HTMLElement | null>(null);
  const result = render(() => (
    <div ref={setScrollRef} style={{ height: '600px', overflow: 'auto' }}>
      <VirtualRows items={items} scrollElement={scrollRef} rowHeight={56}>
        {(item) => <div data-testid="row">{item()?.title}</div>}
      </VirtualRows>
    </div>
  ));
  return { ...result, items };
}

// jsdom performs no layout, so the visible window a virtualizer computes is
// always empty here — how many rows it renders is only observable in a real
// browser, and `tests/browser/` covers that. What these tests pin is the part
// jsdom can see: the list never materialises every row, and the scroll extent
// it reserves matches the full list.
describe('VirtualRows', () => {
  it('does not render a row per item', () => {
    renderRows(5000);

    expect(screen.queryAllByTestId('row').length).toBeLessThan(60);
  });

  it('reserves the full scroll height so the scrollbar is honest', () => {
    const { container } = renderRows(100);

    const spacer = container.querySelector('[data-virtual-rows]') as HTMLElement;
    expect(spacer.style.height).toBe(`${100 * 56}px`);
  });

  it('renders nothing for an empty list', () => {
    const { container } = renderRows(0);

    expect(screen.queryAllByTestId('row')).toHaveLength(0);
    expect((container.querySelector('[data-virtual-rows]') as HTMLElement).style.height).toBe('0px');
  });
});
