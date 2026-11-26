import { createSignal, For, lazy, Show, Suspense } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { ViewHeader } from '../components/ViewHeader';
import SavedEntities from '../components/SavedEntities';
import { MusicLink } from '../components/MusicLinks';
import { navigationItems, libraryViews } from '../components/primaryNavigation';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { reselectPrimaryTab } from '../lib/tabNavigation';
import { t } from '../lib/i18n';
import type { SavedEntity } from '../lib/savedEntities';
import styles from './LibraryHome.module.css';

const BookmarkHeader = lazy(() => import('./BookmarkHeader'));
const HomeNewReleases = lazy(() => import('../components/HomeNewReleases'));

/** Main-shell landing page. */
export default function LibraryHome() {
  const [params] = useSearchParams();
  const savedView = () => params.saved === 'bookmarks' || params.saved === 'albums' || params.saved === 'artists' ? params.saved : undefined;
  const kind = () => savedView() === 'albums' ? 'album' : savedView() === 'artists' ? 'artist' : undefined;
  const expanded = () => Boolean(savedView());
  const [match, setMatch] = createSignal<(entry: SavedEntity) => boolean>();
  const shortcuts = [
    ...libraryViews.slice(0, 3),
    ...['/favourites', '/playlists', '/podcasts'].map(href => navigationItems.find(item => item.href === href)!),
  ];
  const title = () => savedView() === 'bookmarks'
    ? t('savedEntities.title')
    : kind() === 'album' ? t('savedEntities.albums') : kind() === 'artist' ? t('savedEntities.artists') : t('nav.library');
  return <div class="view">
    <Show when={expanded()} fallback={<ViewHeader title={title()} onTitleTap={() => reselectPrimaryTab('/')} />}>
      <BookmarkHeader title={title()} kind={kind()} onMatchChange={matcher => setMatch(() => matcher)} />
    </Show>
    <div class={styles.body} ref={element => registerPrimaryScroll(element)} data-primary-scroll>
      <Show when={!expanded()} fallback={<MusicLink class={styles.back} path="/">← {t('savedEntities.back')}</MusicLink>}>
        <section aria-label={t('savedEntities.library')} class={styles.library}>
          <h2>{t('savedEntities.library')}</h2>
          <div class={styles.shortcuts}><For each={shortcuts}>{item =>
            <MusicLink path={item.href} class={styles.shortcut}><span aria-hidden="true">{item.icon()}</span>{item.label()}</MusicLink>
          }</For></div>
        </section>
      </Show>
      <SavedEntities kind={kind()} expanded={expanded()} match={match()} />
      <Show when={!expanded()}>
        <Suspense>
          <HomeNewReleases />
        </Suspense>
      </Show>
    </div>
  </div>;
}
