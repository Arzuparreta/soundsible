import { render, fireEvent } from '@solidjs/testing-library';
import { expect, it, vi } from 'vitest';
import { mockScrollportLayout } from '../testLayout';
import { VirtualBrowseRows } from './VirtualBrowseRows';

mockScrollportLayout(400, 560);

it('bounds native browse rows and sends the visible item index after a slot is reused', async () => {
  const onPlay = vi.fn();
  const tracks = Array.from({ length: 1000 }, (_, index) => ({ id: `file-${index}`, title: `Song ${index}`, artist: 'Artist' }));
  const { container } = render(() => <VirtualBrowseRows tracks={tracks} onPlay={onPlay} />);
  const scroller = container.querySelector<HTMLElement>('[data-library-scroll]')!;
  expect(container.querySelectorAll('[data-browse-track-id]').length).toBeLessThan(30);
  scroller.scrollTop = 500 * 56;
  scroller.dispatchEvent(new Event('scroll'));
  await new Promise(resolve => setTimeout(resolve, 250));
  await fireEvent.click(container.querySelector('[data-browse-track-id="file-500"] [data-row-main]')!);
  expect(onPlay).toHaveBeenCalledWith(500);
});
