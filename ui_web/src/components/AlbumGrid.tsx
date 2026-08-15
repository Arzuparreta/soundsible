import { For } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { coverUrl } from '../lib/media';
import { trackCount } from '../lib/format';
import { attachContextMenu } from '../lib/contextMenu';
import { albumPath } from '../lib/artistRoute';
import { albumMenuOptions } from './albumActions';
import type { CatalogAlbum } from '../types/music';
import styles from './AlbumGrid.module.css';
import { coverStyle } from '../lib/cover';
import { createResponsiveTap } from '../lib/responsiveTap';

/** Grid of album cards (square covers) linking to each record's detail view.
 *
 * The rows come from the engine's catalog, so a card is a record rather than a
 * title: two albums that happen to share a name are two cards, and a
 * compilation is credited to Various Artists. */
export default function AlbumGrid(props: { albums: CatalogAlbum[] }) {
  const navigate = useNavigate();
  const cover = (album: CatalogAlbum) =>
    coverStyle(album.title, album.cover_track_id ? coverUrl(album.cover_track_id, 'thumb') : undefined);
  return (
    <div class={styles.grid}>
      <For each={props.albums}>
        {(album) => {
          const href = albumPath(album.title, album.album_artist, {
            view: 'library',
            albumId: album.id,
          });
          const tap = createResponsiveTap({
            onTap: (event) => {
              event.preventDefault();
              navigate(href);
            },
          });
          return (
            <A
              href={href}
              class={styles.card}
              data-pressable
              ref={(el) => attachContextMenu(el, () => albumMenuOptions(album, { navigate }))}
              {...tap}
            >
              <div class={styles.cover} style={cover(album)} />
              <span class={styles.title}>{album.title}</span>
              <span class={styles.artist}>{album.album_artist}</span>
              <span class={styles.count}>{trackCount(album.track_count)}</span>
            </A>
          );
        }}
      </For>
    </div>
  );
}
