import { createEffect, createMemo, createSignal, lazy, on, For, Show, Suspense, onMount } from 'solid-js';
import { entitiesError, entitiesLoading, savedEntities, syncSavedEntities, type SavedEntity } from '../lib/savedEntities';
import { t } from '../lib/i18n';
import { MusicLink } from './MusicLinks';
import { CoverImage } from './CoverImage';
import { openSavedEntityMenu } from './savedEntityActions';
import { coverGradient } from '../lib/cover';
import { SkeletonCards } from './Skeleton';
import { MoreIcon, PinIcon } from './icons';
import Button from './Button';
import styles from './SavedEntities.module.css';

// Loaded only on the expanded bookmark subviews so the Library landing
// payload does not carry CollectionSearch or librarySearch on first paint.
const [savedMatcher, setSavedMatcher] = createSignal<((entry: SavedEntity, raw: string) => boolean) | undefined>();
const LazyCollectionSearch = lazy(async () => {
  const [searchMod, libMod] = await Promise.all([import('./CollectionSearch'), import('../lib/librarySearch')]);
  setSavedMatcher(() => (entry: SavedEntity, raw: string) => libMod.matchesSavedEntity(entry, libMod.normalizeLibraryQuery(raw)));
  return { default: searchMod.CollectionSearch };
});

/** Pinned artist and album bookmarks, displayed inside the Library root's ordinary page scroller. */
export default function SavedEntities(props: { kind?: SavedEntity['kind']; expanded?: boolean; match?: (entry: SavedEntity) => boolean }) {
  onMount(() => void syncSavedEntities());
  const [value, setValue] = createSignal('');
  createEffect(on(() => [props.kind, props.expanded] as const, () => setValue(''), { defer: true }));
  const source = (kind: SavedEntity['kind']) => savedEntities().filter(entry => entry.kind === kind);
  const entries = createMemo(() => {
    if (props.match) return savedEntities().filter(props.match);
    const raw = value().trim();
    if (!raw) return savedEntities();
    const fn = savedMatcher();
    return fn ? savedEntities().filter(entry => fn(entry, raw)) : savedEntities();
  });
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
    <Show when={props.expanded && entitiesLoading() && !savedEntities().length}><SkeletonCards count={3} /></Show>
    <Show when={unifiedExpanded() && savedEntities().length}>
      <Suspense><LazyCollectionSearch search={{ value, setValue }} /></Suspense>
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
              <MusicLink class={styles.more} path={`/?saved=${kind === 'album' ? 'albums' : 'artists'}`} label={`${t('searchHome.seeAll')}: ${heading(kind)}`}>{t('searchHome.seeAll')}</MusicLink>
            </Show>
          </div>
          <Show when={props.expanded && Boolean(props.kind) && source(kind).length}>
            <Suspense><LazyCollectionSearch search={{ value, setValue }} /></Suspense>
          </Show>
          <Show when={matches().length} fallback={<Show when={!entitiesLoading() && !entitiesError()}>
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
