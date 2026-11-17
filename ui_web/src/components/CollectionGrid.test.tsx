import { render } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
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
});
