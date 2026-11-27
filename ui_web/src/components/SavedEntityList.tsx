import { createMemo, For, Show } from 'solid-js';
import type { SavedEntity } from '../lib/savedEntityIdentity';
import { t } from '../lib/i18n';
import type { MenuEvent } from '../lib/menuEvent';
import { MusicLink } from './MusicLinks';
import { CoverImage } from './CoverImage';
import { coverGradient } from '../lib/cover';
import { IconButton } from '../design/Control';
import { SkeletonCards, SkeletonHeading, SkeletonRegion } from '../design/Skeleton';
import { MoreIcon, PinIcon } from './icons';
import Button from './Button';
import styles from './SavedEntities.module.css';

export interface SavedEntitiesProps {
  kind?: SavedEntity['kind'];
  expanded?: boolean;
  match?: (entry: SavedEntity) => boolean;
}

export function SavedEntityList(props: SavedEntitiesProps & {
  entries: readonly SavedEntity[];
  loading?: boolean;
  failed?: boolean;
  retry?: () => void;
  onOpen?: (path: string) => void;
  onMenu?: (entry: SavedEntity, event?: MenuEvent) => void;
}) {
  const source = (kind: SavedEntity['kind']) => props.entries.filter(entry => entry.kind === kind);
  const entries = createMemo(() => props.match ? props.entries.filter(props.match) : props.entries);
  const heading = (kind: SavedEntity['kind']) => t(kind === 'album' ? 'savedEntities.albums' : 'savedEntities.artists');
  const unifiedExpanded = () => Boolean(props.expanded && !props.kind);
  return <div aria-busy={props.loading}>
    {/* One line for the whole collection, whichever rows are shown: a failed
      * read is said once, with its retry, and never mistaken for "nothing bookmarked". */}
    <Show when={props.failed}>
      <p class={styles.status} role="status">
        <span><strong>{t('savedEntities.title')}</strong> · {t('common.loadFailed')}</span>
        <Button variant="secondary" size="sm" disabled={props.loading} onClick={() => props.retry?.()}>{t('common.retry')}</Button>
      </p>
    </Show>
    <Show when={unifiedExpanded() && props.loading && !props.entries.length}>
      <SkeletonRegion>
        <div class={styles.section}>
          <div class={styles.header}><SkeletonHeading size="h2" /></div>
          <SkeletonCards count={6} shape="round" lines={1} class={`${styles.rail} ${styles.expanded}`} decorative />
        </div>
        <div class={styles.section}>
          <div class={styles.header}><SkeletonHeading size="h2" /></div>
          <SkeletonCards count={6} lines={2} class={`${styles.rail} ${styles.expanded}`} decorative />
        </div>
      </SkeletonRegion>
    </Show>
    <Show when={unifiedExpanded() && !entries().length && !props.loading && !props.failed}>
      <p class={styles.empty}>{t(props.entries.length > 0 ? 'library.noCollectionMatches' : 'savedEntities.empty')}</p>
    </Show>
    <For each={props.kind ? [props.kind] : ['artist', 'album'] as const}>{kind => {
      const matches = createMemo(() => entries().filter(entry => entry.kind === kind));
      return <Show when={(props.expanded && Boolean(props.kind)) || matches().length}>
        <section class={styles.section} aria-label={heading(kind)}>
          <div class={styles.header}>
            <h2><PinIcon size={18} class={styles.pin} /><span>{heading(kind)}</span></h2>
            <Show when={!props.expanded && !props.match && matches().length}>
              <MusicLink class={styles.more} path={`/bookmarks/${kind === 'album' ? 'albums' : 'artists'}`} label={`${t('searchHome.seeAll')}: ${heading(kind)}`}>{t('searchHome.seeAll')}</MusicLink>
            </Show>
          </div>
          <Show when={matches().length} fallback={<Show when={!props.loading && !props.failed} fallback={
            <Show when={props.expanded && props.loading && !props.entries.length}>
              <SkeletonCards count={12} shape={kind === 'artist' ? 'round' : 'square'} lines={kind === 'album' ? 2 : 1} class={`${styles.rail} ${styles.expanded}`} />
            </Show>
          }>
            <p class={styles.empty}>{t(source(kind).length > 0 ? 'library.noCollectionMatches' : 'savedEntities.empty')}</p>
          </Show>}>
            <div class={styles.rail} data-horizontal-scroll={props.expanded ? undefined : ''} classList={{ [styles.expanded]: props.expanded || !!props.match }}>
              <For each={matches()}>{entry => {
                const menu = props.onMenu ? (event?: MenuEvent) => props.onMenu?.(entry, event) : undefined;
                return <article class={styles.card}>
                  <MusicLink class={styles.link} path={entry.destination} label={entry.name} onOpen={props.onOpen} onMenu={menu}>
                    <div class={styles.cover} classList={{ [styles.round]: entry.kind === 'artist' }} style={{ background: coverGradient(entry.name) }}><CoverImage src={entry.cover} /></div>
                    <span class={styles.name}>{entry.name}</span>
                    <Show when={entry.kind === 'album' && entry.artist}><span class={styles.credit}>{entry.artist}</span></Show>
                  </MusicLink>
                  <Show when={menu}><IconButton class={styles.menu} label={`${t('savedEntities.options')}: ${entry.name}`} aria-haspopup="dialog" onClick={menu}><MoreIcon size={18} /></IconButton></Show>
                </article>;
              }}</For>
            </div>
          </Show>
        </section>
      </Show>
    }}</For>
  </div>;
}
