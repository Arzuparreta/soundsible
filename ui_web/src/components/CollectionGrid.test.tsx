import { render } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { CollectionGrid } from './CollectionGrid';
import { mockScrollportLayout } from '../testLayout';

mockScrollportLayout(400, 600);

const settle = () => new Promise((done) => setTimeout(done, 250));

function mount(count: number) {
  let scroller!: HTMLDivElement;
  let built = 0;
  const items = Array.from({ length: count }, (_, at) => `Card ${at}`);
  const view = render(() => (
    <div ref={scroller} data-primary-scroll>
      <CollectionGrid items={items} class="grid">
        {(item, index) => {
          built += 1;
          return <a data-card data-at={index()}>{item()}</a>;
        }}
      </CollectionGrid>
    </div>
  ));
  const cards = () => [...view.container.querySelectorAll<HTMLElement>('[data-card]')];
  const scrollTo = (top: number) => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event('scroll'));
  };
  return { cards, scrollTo, built: () => built, view };
}

describe('CollectionGrid', () => {
  it('renders the first rows of a long grid, not the whole grid', () => {
    const { cards } = mount(2000);
    expect(cards()[0].textContent).toBe('Card 0');
    expect(cards().length).toBeGreaterThan(2);
    expect(cards().length).toBeLessThan(40);
  });

  it('stands in for the rows it does not render', async () => {
    const { cards, scrollTo, view } = mount(2000);
    expect(view.container.querySelectorAll('[data-grid-spacer]').length).toBe(1);
    scrollTo(224 * 500);
    await settle();
    expect(view.container.querySelectorAll('[data-grid-spacer]').length).toBe(2);
    expect(cards().some((card) => card.textContent === 'Card 500')).toBe(true);
  });

  it('reuses its cards for the rows scrolled to and ends in list order', async () => {
    const { cards, scrollTo, built } = mount(2000);
    const before = built();
    scrollTo(224 * 500);
    await settle();
    expect(built() - before).toBeLessThanOrEqual(6);
    const order = cards().map((card) => Number(card.dataset.at));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('renders every card of a grid shorter than the scrollport', () => {
    const { cards, view } = mount(2);
    expect(cards().map((card) => card.textContent)).toEqual(['Card 0', 'Card 1']);
    expect(view.container.querySelectorAll('[data-grid-spacer]').length).toBe(0);
  });

  it('re-measures row heights when card columnWidth changes without changing column count', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const originalRO = globalThis.ResizeObserver;
    const originalGCS = window.getComputedStyle;
    let width = 800;
    let colWidth = 180;

    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) { resizeCallbacks.push(cb); }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;

    const gridWidthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    const computedSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const base = originalGCS.call(window, el, pseudo);
      if (el instanceof HTMLElement && el.classList.contains('grid')) {
        return new Proxy(base, {
          get(target, prop) {
            if (prop === 'paddingTop') return '0px';
            if (prop === 'rowGap') return '16px';
            if (prop === 'gridTemplateColumns') return `${colWidth}px ${colWidth}px ${colWidth}px ${colWidth}px`;
            const val = Reflect.get(target, prop, target);
            return typeof val === 'function' ? val.bind(target) : val;
          },
        });
      }
      return base;
    });

    try {
      const { view } = mount(40);
      await settle();
      const spacer = () => view.container.querySelector<HTMLElement>('[data-grid-spacer]');
      const initialSpacerHeight = parseFloat(spacer()?.style.height || '0');
      expect(initialSpacerHeight).toBeGreaterThan(0);

      // Simulate sidebar collapse: same 4 columns, wider cards (180px -> 230px).
      width = 1000;
      colWidth = 230;
      for (const cb of resizeCallbacks) cb([], {} as ResizeObserver);
      await settle();

      const updatedSpacerHeight = parseFloat(spacer()?.style.height || '0');
      expect(updatedSpacerHeight).toBeGreaterThan(initialSpacerHeight);
    } finally {
      globalThis.ResizeObserver = originalRO;
      gridWidthSpy.mockRestore();
      computedSpy.mockRestore();
    }
  });
});
