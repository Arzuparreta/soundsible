import { For, type JSX } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { coverUrl } from '../lib/media';
import { trackCount } from '../lib/format';
import { attachContextMenu } from '../lib/contextMenu';
import { artistPath } from '../lib/artistRoute';
import { artistMenuOptions } from './artistActions';
import type { ArtistEntry } from '../lib/libraryView';
import styles from './ArtistGrid.module.css';
import { coverBackground } from '../lib/cover';

/** Grid of artist cards (round avatars) linking to each artist's detail view. */
export default function ArtistGrid(props: { artists: ArtistEntry[] }) {
  const navigate = useNavigate();
  const bg = (a: ArtistEntry): JSX.CSSProperties => ({
    background: coverBackground(a.name, coverUrl(a.coverId)),
  });
  return (
    <div class={styles.grid}>
      <For each={props.artists}>
        {(a) => (
          <A
            href={artistPath(a.name, { view: 'library' })}
            class={styles.card}
            ref={(el) => attachContextMenu(el, () => artistMenuOptions(a.name, { navigate }))}
          >
            <div class={styles.avatar} style={bg(a)} />
            <span class={styles.name}>{a.name}</span>
            <span class={styles.count}>{trackCount(a.count)}</span>
          </A>
        )}
      </For>
    </div>
  );
}
