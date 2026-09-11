import { MusicLink } from './MusicLinks';
import { For } from 'solid-js';
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
    <div class={styles.grid}>
      <For each={props.artists}>
        {(a) => {
          const href = artistPath(a.name, { view: 'library', artistId: a.id });
          return (
            <MusicLink
              path={href}
              class={styles.card}
              onMenu={(event) => openArtistMenu(a.name, {}, event)}
            >
              <div class={styles.avatar} style={{ position: 'relative', background: coverGradient(a.name) }}><CoverImage src={coverUrl(a.coverId)} /></div>
              <span class={styles.name}>{a.name}</span>
              <span class={styles.count}>{trackCount(a.count)}</span>
            </MusicLink>
          );
        }}
      </For>
    </div>
  );
}
