import { batch, createSignal } from 'solid-js';
import { render } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { CollectionRows } from './CollectionView';

// jsdom lays nothing out; give the scrollport the size the virtualizer reads.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 400 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 560 });
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
}

const settle = () => new Promise((done) => setTimeout(done, 250));

function mount(count = 1000, keyed = false, pinned = () => -1) {
  let scroller!: HTMLDivElement;
  let built = 0;
  const [items, setItems] = createSignal(Array.from({ length: count }, (_, at) => `Item ${at}`));
  const view = render(() => (
    <div ref={scroller} style={{ height: '560px', overflow: 'auto' }}>
      <CollectionRows items={items()} scrollElement={() => scroller} rowHeight={56}
        itemKey={keyed ? item => item : undefined} keepMountedIndex={pinned()}>
        {(item, index) => {
          built += 1;
          return <button data-row data-at={index()}>{item()}</button>;
        }}
      </CollectionRows>
    </div>
  ));
  const rows = () => [...view.container.querySelectorAll<HTMLElement>('[data-row]')];
  const scrollTo = (top: number) => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event('scroll'));
  };
  return { rows, scrollTo, setItems, built: () => built };
}

describe('CollectionRows', () => {
  it('renders only the rows near the scrollport', () => {
    const { rows } = mount();
    expect(rows().length).toBeGreaterThan(9);
    expect(rows().length).toBeLessThan(30);
    expect(rows()[0].textContent).toBe('Item 0');
  });

  it('shows the rows scrolled to without building new ones', async () => {
    const { rows, scrollTo, built } = mount();
    const before = built();
    const nodes = new Set(rows());
    scrollTo(56 * 500);
    await settle();
    expect(rows().some((row) => row.textContent === 'Item 500')).toBe(true);
    expect(rows().every((row) => Number(row.dataset.at) > 480 && Number(row.dataset.at) < 530)).toBe(true);
    // The same elements, showing other items: a few more at most, because the
    // middle of a list has rows on both sides of the window.
    expect(rows().filter((row) => nodes.has(row)).length).toBe(nodes.size);
    expect(built() - before).toBeLessThanOrEqual(8);
  });

  it('is in list order in the document once the list is at rest', async () => {
    const { rows, scrollTo } = mount();
    scrollTo(56 * 3);
    scrollTo(56 * 40);
    scrollTo(56 * 37);
    await settle();
    const order = rows().map((row) => Number(row.dataset.at));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('does not carry focus to the item that takes over a slot', async () => {
    const { rows, scrollTo } = mount();
    rows()[0].focus();
    expect(document.activeElement).toBe(rows()[0]);
    scrollTo(56 * 500);
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it('follows the list when it changes behind a mounted row', () => {
    const { rows, setItems } = mount(3);
    setItems(['New first', 'Item 0', 'Item 1', 'Item 2']);
    expect(rows().map((row) => row.textContent)).toEqual(['New first', 'Item 0', 'Item 1', 'Item 2']);
    setItems(['New first']);
    expect(rows().map((row) => row.textContent)).toEqual(['New first']);
  });

  it('keeps an edited occurrence mounted and focused across scrolling and reordering', async () => {
    const [pinned, setPinned] = createSignal(5);
    const { rows, setItems, scrollTo } = mount(1000, true, pinned);
    const edited = rows().find(row => row.textContent === 'Item 5')!;
    edited.focus();
    scrollTo(56 * 500);
    await settle();
    expect(edited.isConnected).toBe(true);
    expect(edited.textContent).toBe('Item 5');
    expect(document.activeElement).toBe(edited);
    batch(() => {
      setPinned(6);
      setItems(['Inserted', ...Array.from({ length: 1000 }, (_, index) => `Item ${index}`)]);
    });
    await settle();
    expect(rows().find(row => row.textContent === 'Item 5')).toBe(edited);
    expect(document.activeElement).toBe(edited);
  });
});
