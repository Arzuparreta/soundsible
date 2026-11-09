import { For, Show, onMount } from 'solid-js';
import { entitiesError, entitiesLoading, savedEntities, syncSavedEntities, type SavedEntity } from '../lib/savedEntities';
import { t } from '../lib/i18n';
import { MusicLink } from './MusicLinks';
import { CoverImage } from './CoverImage';
import { openSavedEntityMenu } from './savedEntityActions';
import { coverGradient } from '../lib/cover';
import { SkeletonCards } from './Skeleton';
import { MoreIcon } from './icons';
import Button from './Button';
import styles from './SavedEntities.module.css';

/** The two saved collections, displayed inside the Library root's ordinary page scroller. */
export default function SavedEntities(props: { kind?: SavedEntity['kind']; expanded?: boolean; query?: string }) {
  onMount(() => void syncSavedEntities());
  const entries = (kind: SavedEntity['kind']) => {
    const query = (props.query ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
    return savedEntities().filter(entry => entry.kind === kind &&
      `${entry.name} ${entry.artist ?? ''}`.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().includes(query));
  };
  const heading = (kind: SavedEntity['kind']) => t(kind === 'album' ? 'savedEntities.albums' : 'savedEntities.artists');
  return <div aria-busy={entitiesLoading()}>
    {/* One line for the whole collection, whichever rows are shown: a failed
      * read is said once, with its retry, and never mistaken for "nothing saved". */}
    <Show when={entitiesError()}>
      <p class={styles.status} role="status">
        <span><strong>{t('savedEntities.title')}</strong> · {t('common.loadFailed')}</span>
        <Button variant="secondary" size="sm" disabled={entitiesLoading()} onClick={() => void syncSavedEntities()}>{t('common.retry')}</Button>
      </p>
    </Show>
    <Show when={props.expanded && entitiesLoading() && !savedEntities().length}><SkeletonCards count={3} /></Show>
    <For each={props.kind ? [props.kind] : ['album', 'artist'] as const}>{kind =>
      <Show when={props.expanded || entries(kind).length}>
        <section class={styles.section} aria-label={heading(kind)}>
          <div class={styles.header}><h2>{heading(kind)}</h2>
            <Show when={!props.expanded && !props.query && entries(kind).length}>
              <MusicLink class={styles.more} path={`/?saved=${kind === 'album' ? 'albums' : 'artists'}`} label={`${t('searchHome.seeAll')}: ${heading(kind)}`}>{t('searchHome.seeAll')}</MusicLink>
            </Show>
          </div>
          <Show when={entries(kind).length} fallback={<Show when={!entitiesLoading() && !entitiesError()}><p class={styles.empty}>{t('savedEntities.empty')}</p></Show>}>
            <div class={styles.rail} data-horizontal-scroll={props.expanded ? undefined : ''} classList={{ [styles.expanded]: props.expanded || !!props.query }}>
              <For each={entries(kind)}>{entry => <article class={styles.card}>
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
    }</For>
  </div>;
}
