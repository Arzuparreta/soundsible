import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { ViewHeader } from '../components/ViewHeader';
import { createSearchReveal } from '../components/SearchReveal';
import { collectionSearchField } from '../components/collectionSearchField';
import { savedEntities } from '../lib/savedEntities';
import SavedEntities from '../components/SavedEntities';
import { MusicLink } from '../components/MusicLinks';
import { navigationItems, libraryViews } from '../components/primaryNavigation';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { reselectPrimaryTab } from '../lib/tabNavigation';
import { t } from '../lib/i18n';
import styles from './LibraryHome.module.css';

/** Main-shell landing page. */
export default function LibraryHome() {
  const [params] = useSearchParams();
  const savedView = () => params.saved === 'bookmarks' || params.saved === 'albums' || params.saved === 'artists' ? params.saved : undefined;
  const kind = () => savedView() === 'albums' ? 'album' : savedView() === 'artists' ? 'artist' : undefined;
  const expanded = () => Boolean(savedView());
  const [query, setQuery] = createSignal('');
  const reveal = createSearchReveal(() => collectionSearchField(query, setQuery));
  createEffect(on(savedView, () => { setQuery(''); reveal.reset(); }, { defer: true }));
  const canSearch = () => expanded() && savedEntities().some(entry => !kind() || entry.kind === kind());
  const shortcuts = [
    ...libraryViews.slice(0, 3),
    ...['/favourites', '/playlists', '/podcasts'].map(href => navigationItems.find(item => item.href === href)!),
  ];
  const title = () => savedView() === 'bookmarks'
    ? t('savedEntities.title')
    : kind() === 'album' ? t('savedEntities.albums') : kind() === 'artist' ? t('savedEntities.artists') : t('nav.library');
  return <div class="view">
    <ViewHeader
      title={title()}
      search={canSearch() ? reveal : undefined}
      onTitleTap={expanded() ? undefined : () => reselectPrimaryTab('/')}
    />
    <div class={styles.body} ref={element => registerPrimaryScroll(element)} data-primary-scroll>
      <Show when={!expanded()} fallback={<MusicLink class={styles.back} path="/">← {t('savedEntities.back')}</MusicLink>}>
        <section aria-label={t('savedEntities.library')} class={styles.library}>
          <h2>{t('savedEntities.library')}</h2>
          <div class={styles.shortcuts}><For each={shortcuts}>{item =>
            <MusicLink path={item.href} class={styles.shortcut}><span aria-hidden="true">{item.icon()}</span>{item.label()}</MusicLink>
          }</For></div>
        </section>
      </Show>
      <SavedEntities kind={kind()} expanded={expanded()} query={query()} />
    </div>
  </div>;
}
