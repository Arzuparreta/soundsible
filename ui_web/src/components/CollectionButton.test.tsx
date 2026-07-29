/** @jsxImportSource solid-js */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';

const { actions, held } = vi.hoisted(() => ({
  actions: { toggleSaved: vi.fn(), downloadSaved: vi.fn() },
  held: { saved: false, owned: false, downloading: false },
}));

vi.mock('../stores', () => ({
  actions,
  isSavedKeys: () => held.saved,
  ownedTrackForKeys: () => (held.owned ? { id: 'lib1', title: 'Song', artist: 'A' } : null),
  isDownloadingKeys: () => held.downloading,
}));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));

import { CollectionButton } from './CollectionButton';

const entry = { keys: ['yt:vid'], title: 'Weightless', artist: 'Marconi Union' };

beforeEach(() => {
  vi.clearAllMocks();
  held.saved = false;
  held.owned = false;
  held.downloading = false;
});

describe('CollectionButton — the two halves of having a song', () => {
  it('offers to claim a song it does not hold, without downloading anything', () => {
    const { getByRole } = render(() => <CollectionButton entry={entry} />);
    const button = getByRole('button');

    expect(button).toHaveAttribute('data-state', 'unsaved');
    expect(button).toHaveAttribute('aria-label', 'collection.save');

    fireEvent.click(button);
    expect(actions.toggleSaved).toHaveBeenCalledWith(entry);
    expect(actions.downloadSaved).not.toHaveBeenCalled();
  });

  it('offers the file once the song is in the library — the second, separate step', () => {
    held.saved = true;
    const { getByRole } = render(() => <CollectionButton entry={entry} />);
    const button = getByRole('button');

    expect(button).toHaveAttribute('data-state', 'streaming');
    expect(button).toHaveAttribute('aria-label', 'collection.download');

    fireEvent.click(button);
    expect(actions.downloadSaved).toHaveBeenCalledWith(entry);
    expect(actions.toggleSaved).not.toHaveBeenCalled();
  });

  it('lets a surface do the downloading when it knows how', () => {
    held.saved = true;
    const onDownload = vi.fn();
    const { getByRole } = render(() => <CollectionButton entry={entry} onDownload={onDownload} />);

    fireEvent.click(getByRole('button'));
    expect(onDownload).toHaveBeenCalled();
    expect(actions.downloadSaved).not.toHaveBeenCalled();
  });

  it('states ownership rather than offering it: the tick does nothing', () => {
    held.saved = true;
    held.owned = true;
    const { getByRole } = render(() => <CollectionButton entry={entry} />);
    const button = getByRole('button');

    expect(button).toHaveAttribute('data-state', 'owned');
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(actions.toggleSaved).not.toHaveBeenCalled();
    expect(actions.downloadSaved).not.toHaveBeenCalled();
  });

  it('takes no space on a downloaded row — no tick, and no box where one was', () => {
    held.saved = true;
    held.owned = true;
    const { container, queryByRole } = render(() => <CollectionButton entry={entry} hideOwned />);

    expect(queryByRole('button')).toBeNull();
    expect(container.firstElementChild).toBeNull();
  });

  it('spins while the download is in flight, offering nothing to press', () => {
    held.saved = true;
    held.downloading = true;
    const { queryByRole } = render(() => <CollectionButton entry={entry} />);

    expect(queryByRole('button')).toBeNull();
  });

  it('spins for a surface arranging its own download, before any queue exists', () => {
    // A catalog row has to be matched to a video first; the row must not keep
    // offering the arrow while that round trip is in the air.
    held.saved = true;
    const { queryByRole } = render(() => <CollectionButton entry={entry} busy />);

    expect(queryByRole('button')).toBeNull();
  });
});
