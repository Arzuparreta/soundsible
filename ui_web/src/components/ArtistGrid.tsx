import { For, type JSX } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { coverUrl } from '../lib/media';
import { attachContextMenu } from '../lib/contextMenu';
import { artistMenuOptions } from './artistActions';
import type { ArtistEntry } from '../lib/libraryView';
import styles from './ArtistGrid.module.css';

function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 50% 32%), hsl(${(h + 50) % 360} 55% 20%))`;
}

/** Grid of artist cards (round avatars) linking to each artist's detail view. */
export default function ArtistGrid(props: { artists: ArtistEntry[] }) {
  const navigate = useNavigate();
  const bg = (a: ArtistEntry): JSX.CSSProperties => ({
    background: `url("${coverUrl(a.coverId)}") center / cover no-repeat, ${gradientFor(a.name)}`,
  });
  return (
    <div class={styles.grid}>
      <For each={props.artists}>
        {(a) => (
          <A
            href={`/artist/${encodeURIComponent(a.name)}`}
            class={styles.card}
            ref={(el) => attachContextMenu(el, () => artistMenuOptions(a.name, { navigate }))}
          >
            <div class={styles.avatar} style={bg(a)} />
            <span class={styles.name}>{a.name}</span>
            <span class={styles.count}>{a.count} pistas</span>
          </A>
        )}
      </For>
    </div>
  );
}
