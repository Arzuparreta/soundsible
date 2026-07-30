import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shareUrlFor, shareTrack } from './share';
import { toast } from './toast';

const mocks = vi.hoisted(() => ({ openCopyLinkDialog: vi.fn() }));
vi.mock('./copyLink', () => ({ openCopyLinkDialog: mocks.openCopyLinkDialog }));

describe('shareUrlFor', () => {
  it('uses the explicit youtube_id for library tracks', () => {
    expect(
      shareUrlFor({ id: 'lib-1', title: 'Song', artist: 'Artist', youtube_id: 'dQw4w9WgXcQ' }),
    ).toMatch(/\/open\/#t=/);
  });

  it('uses the id as the video id for preview (Discover/Search) tracks', () => {
    expect(
      shareUrlFor({ id: '9bZkp7q19f0', title: 'Song', artist: 'Artist', source: 'preview' }),
    ).toMatch(/\/open\/#t=/);
  });

  it('shares the exact id used by preview playback when youtube_id disagrees', () => {
    const url = shareUrlFor({
      id: 'dQw4w9WgXcQ',
      title: 'Song',
      artist: 'Artist',
      source: 'preview',
      youtube_id: '9bZkp7q19f0',
    });
    expect(url).toMatch(/\/open\/#t=/);
  });

  it('returns no url for podcast episodes (id is a guid, not a video)', () => {
    expect(
      shareUrlFor({ id: 'ep-guid', title: 'Episode', source: 'preview', media_kind: 'podcast_episode', podcast_episode_guid: 'ep-guid' }),
    ).toBe('');
  });

  it('returns no url for a library track without a youtube_id', () => {
    expect(shareUrlFor({ id: 'lib-2', title: 'Song' })).toBe('');
  });
});

const TRACK = { id: 'lib-1', title: 'Song', artist: 'Artist', youtube_id: 'dQw4w9WgXcQ' };

/** Drop the APIs a browser exposes only in a secure context. */
function insecureContext(): void {
  const nav = navigator as unknown as Record<string, unknown>;
  delete nav.share;
  delete nav.clipboard;
}

function withClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

function withShare(share: (data: ShareData) => Promise<void>): void {
  Object.defineProperty(navigator, 'share', { value: share, configurable: true });
}

function withExecCommand(result: boolean | (() => boolean)): ReturnType<typeof vi.fn> {
  const exec = vi.fn(() => (typeof result === 'function' ? result() : result));
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
  return exec;
}

describe('shareTrack', () => {
  const success = vi.spyOn(toast, 'success');
  const error = vi.spyOn(toast, 'error');

  beforeEach(() => {
    insecureContext();
    success.mockClear();
    error.mockClear();
    mocks.openCopyLinkDialog.mockClear();
  });
  afterEach(() => {
    insecureContext();
    Reflect.deleteProperty(document, 'execCommand');
  });

  // The regression: Soundsible is normally reached over plain HTTP on a LAN or
  // Tailscale address, where neither navigator.share nor navigator.clipboard
  // exists. Reaching for `.writeText` there threw, and every share — downloaded
  // or streamed, YouTube or YouTube Music — reported "could not share".
  it('copies over plain HTTP, where neither share nor clipboard exists', async () => {
    const exec = withExecCommand(true);

    await shareTrack(TRACK);

    expect(exec).toHaveBeenCalledWith('copy');
    expect(success).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(mocks.openCopyLinkDialog).not.toHaveBeenCalled();
  });

  it('leaves no textarea behind after the legacy copy', async () => {
    withExecCommand(true);
    await shareTrack(TRACK);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('prefers the clipboard API when the page is served securely', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard(writeText);

    await shareTrack(TRACK);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0][0])).toMatch(/\/open\/#t=/);
    expect(success).toHaveBeenCalledTimes(1);
  });

  it('falls back to the legacy copy when the clipboard API is denied', async () => {
    withClipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')));
    const exec = withExecCommand(true);

    await shareTrack(TRACK);

    expect(exec).toHaveBeenCalledWith('copy');
    expect(success).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('offers the link by hand when every copy path is refused', async () => {
    withClipboard(vi.fn().mockRejectedValue(new Error('nope')));
    withExecCommand(false);

    await shareTrack(TRACK);

    expect(mocks.openCopyLinkDialog).toHaveBeenCalledTimes(1);
    expect(String(mocks.openCopyLinkDialog.mock.calls[0][0].value)).toMatch(/\/open\/#t=/);
    expect(success).not.toHaveBeenCalled();
  });

  it('uses the native share sheet where the browser has one', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    withShare(share);

    await shareTrack(TRACK);

    expect(share).toHaveBeenCalledTimes(1);
    expect(String(share.mock.calls[0][0].url)).toMatch(/\/open\/#t=/);
    expect(success).not.toHaveBeenCalled();
  });

  it('says nothing when the share sheet is dismissed', async () => {
    withShare(vi.fn().mockRejectedValue(new DOMException('dismissed', 'AbortError')));
    const exec = withExecCommand(true);

    await shareTrack(TRACK);

    expect(exec).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(mocks.openCopyLinkDialog).not.toHaveBeenCalled();
  });

  it('copies instead when the share sheet fails for any other reason', async () => {
    withShare(vi.fn().mockRejectedValue(new DOMException('no target', 'NotAllowedError')));
    const exec = withExecCommand(true);

    await shareTrack(TRACK);

    expect(exec).toHaveBeenCalledWith('copy');
    expect(success).toHaveBeenCalledTimes(1);
  });

  // A podcast episode, or a local track with no video behind it, has no link to
  // give. Sharing its name beats refusing to share at all.
  it('shares title and artist as text when there is no link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard(writeText);

    await shareTrack({ id: 'lib-2', title: 'Song', artist: 'Artist' });

    expect(writeText).toHaveBeenCalledWith('Song — Artist');
    expect(success).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
});
