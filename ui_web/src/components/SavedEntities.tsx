import { createMemo, For, Show, onMount } from 'solid-js';
import { entitiesError, entitiesLoading, savedEntities, syncSavedEntities, type SavedEntity } from '../lib/savedEntities';
import { t } from '../lib/i18n';
import { MusicLink } from './MusicLinks';
import { CoverImage } from './CoverImage';
import { openSavedEntityMenu } from './savedEntityActions';
import { coverGradient } from '../lib/cover';
import { SkeletonCards, SkeletonHeading, SkeletonRegion } from '../design/Skeleton';
import { MoreIcon, PinIcon } from './icons';
import Button from './Button';
import styles from './SavedEntities.module.css';

/** Pinned artist and album bookmarks, shown on Home and on the Bookmarks routes. */
export default function SavedEntities(props: { kind?: SavedEntity['kind']; expanded?: boolean; match?: (entry: SavedEntity) => boolean }) {
  onMount(() => void syncSavedEntities());
  const source = (kind: SavedEntity['kind']) => savedEntities().filter(entry => entry.kind === kind);
  const entries = createMemo(() => props.match ? savedEntities().filter(props.match) : savedEntities());
  const heading = (kind: SavedEntity['kind']) => t(kind === 'album' ? 'savedEntities.albums' : 'savedEntities.artists');
  const unifiedExpanded = () => Boolean(props.expanded && !props.kind);
  return <div aria-busy={entitiesLoading()}>
    {/* One line for the whole collection, whichever rows are shown: a failed
      * read is said once, with its retry, and never mistaken for "nothing bookmarked". */}
    <Show when={entitiesError()}>
      <p class={styles.status} role="status">
        <span><strong>{t('savedEntities.title')}</strong> · {t('common.loadFailed')}</span>
        <Button variant="secondary" size="sm" disabled={entitiesLoading()} onClick={() => void syncSavedEntities()}>{t('common.retry')}</Button>
      </p>
    </Show>
    <Show when={unifiedExpanded() && entitiesLoading() && !savedEntities().length}>
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
    <Show when={unifiedExpanded() && !entries().length && !entitiesLoading() && !entitiesError()}>
      <p class={styles.empty}>{t(savedEntities().length > 0 ? 'library.noCollectionMatches' : 'savedEntities.empty')}</p>
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
          <Show when={matches().length} fallback={<Show when={!entitiesLoading() && !entitiesError()} fallback={
            <Show when={props.expanded && entitiesLoading() && !savedEntities().length}>
              <SkeletonCards count={12} shape={kind === 'artist' ? 'round' : 'square'} lines={kind === 'album' ? 2 : 1} class={`${styles.rail} ${styles.expanded}`} />
            </Show>
          }>
            <p class={styles.empty}>{t(source(kind).length > 0 ? 'library.noCollectionMatches' : 'savedEntities.empty')}</p>
          </Show>}>
            <div class={styles.rail} data-horizontal-scroll={props.expanded ? undefined : ''} classList={{ [styles.expanded]: props.expanded || !!props.match }}>
              <For each={matches()}>{entry => <article class={styles.card}>
                <MusicLink class={styles.link} path={entry.destination} label={entry.name} onMenu={event => openSavedEntityMenu(entry, event)}>
                  <div class={styles.cover} classList={{ [styles.round]: entry.kind === 'artist' }} style={{ background: coverGradient(entry.name) }}><CoverImage src={entry.cover} /></div>
                  <span class={styles.name}>{entry.name}</span>
                  <Show when={entry.kind === 'album' && entry.artist}><span class={styles.credit}>{entry.artist}</span></Show>
                </MusicLink>
                <button class={styles.menu} type="button" aria-label={`${t('savedEntities.options')}: ${entry.name}`} aria-haspopup="dialog" onClick={event => openSavedEntityMenu(entry, event)}><MoreIcon size={18} /></button>
              </article>}</For>
            </div>
          </Show>
        </section>
      </Show>
    }}</For>
  </div>;
}
