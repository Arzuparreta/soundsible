import { render } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));

import SongRow from './SongRow';
import SearchResultRow from './SearchResultRow';

/**
 * Every row type marks "this is sounding" with the same `data-now-playing`
 * attribute, which is what `styles/app.css` paints. The attribute name is a
 * contract between the components and that one stylesheet: if a row invents its
 * own class again, the treatment silently diverges — which is how the search
 * list came to look like nothing was playing.
 */
describe('now playing marker', () => {
  const track = { id: 't1', title: 'Song A', artist: 'Artist A' };
  const result = { id: 'vid123', title: 'Song A', channel: 'Artist A' };

  it('marks the playing library row and leaves the others unmarked', () => {
    const { container, unmount } = render(() => <SongRow track={track} active />);
    expect(container.querySelector('[data-now-playing]')).not.toBeNull();
    unmount();

    const idle = render(() => <SongRow track={track} />);
    expect(idle.container.querySelector('[data-now-playing]')).toBeNull();
  });

  it('marks the playing search row with the same attribute', () => {
    const { container, unmount } = render(() => (
      <SearchResultRow
        r={result}
        active
        onPreview={vi.fn()}
      />
    ));
    expect(container.querySelector('[data-now-playing]')).not.toBeNull();
    unmount();

    const idle = render(() => (
      <SearchResultRow
        r={result}
        active={false}
        onPreview={vi.fn()}
      />
    ));
    expect(idle.container.querySelector('[data-now-playing]')).toBeNull();
  });

  it('keeps announcing the playing row to screen readers', () => {
    const { container } = render(() => <SongRow track={track} active />);
    expect(container.querySelector('[aria-current="true"]')).not.toBeNull();
  });
});
