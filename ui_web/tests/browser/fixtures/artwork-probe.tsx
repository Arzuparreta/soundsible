/** Browser-only harness for the real image component and media adapter. */
import { render } from 'solid-js/web';
import { CoverImage } from '../../../src/components/CoverImage';
import { MusicListRowView } from '../../../src/components/MusicListRowView';
import { registerArtworkMetadata, registerPreviewArtwork, trackCoverUrl } from '../../../src/lib/media';

let dispose: (() => void) | undefined;
export function mount(cover: string, row = false): void {
  dispose?.();
  registerArtworkMetadata([]);
  const root = document.createElement('div');
  root.dataset.coverProbe = '';
  Object.assign(root.style, { position: 'fixed', top: '0', left: '0', width: '300px', height: '300px', zIndex: '99999' });
  document.body.append(root);
  const track = { id: 'abcdefghijk', source: 'preview' as const, cover };
  const cleanup = render(() => row
    ? <MusicListRowView title="Artwork probe" seed={track.id} cover={trackCoverUrl(track, 'thumb')} />
    : <CoverImage src={trackCoverUrl(track)} eager />, root);
  dispose = () => { cleanup(); root.remove(); };
}
export function upgrade(): void {
  registerPreviewArtwork('abcdefghijk', {
    url: 'https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg', width: 1280, height: 720,
  });
}
