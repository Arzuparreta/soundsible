import { MusicLink } from './MusicLinks';
import { Show } from 'solid-js';
import { CollectionGrid } from './CollectionGrid';
import { coverUrl } from '../lib/media';
import { trackCount } from '../lib/format';
import { artistPath } from '../lib/artistRoute';
import { openArtistMenu } from './artistActions';
import type { ArtistEntry } from '../lib/libraryView';
import styles from './ArtistGrid.module.css';
import { coverGradient } from '../lib/cover';
import { CoverImage } from './CoverImage';

/** Grid of artist cards (round avatars) linking to each artist's detail view. */
export default function ArtistGrid(props: { artists: ArtistEntry[] }) {
  return (
    <CollectionGrid items={props.artists} class={styles.grid}>
        {(a) => (
            <MusicLink
              path={artistPath(a().name, { view: 'library', artistId: a().id })}
              class={styles.card}
              onMenu={(event) => openArtistMenu(a().name, { artistId: a().id, cover: coverUrl(a().coverId) }, event)}
            >
              <div class={styles.avatar} style={{ position: 'relative', background: coverGradient(a().name) }}><Show when={coverUrl(a().coverId)} keyed>{(src) => <CoverImage src={src} />}</Show></div>
              <span class={styles.name}>{a().name}</span>
              <span class={styles.count}>{trackCount(a().count)}</span>
            </MusicLink>
        )}
    </CollectionGrid>
  );
}
