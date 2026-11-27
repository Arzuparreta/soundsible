import { createEffect, For, lazy, Show } from 'solid-js';
import { useNavigate, useSearchParams } from '@solidjs/router';
import { ViewHeader } from '../components/ViewHeader';
import SavedEntities from '../components/SavedEntities';
import { MusicLink } from '../components/MusicLinks';
import { navigationItems, libraryViews } from '../components/primaryNavigation';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { reselectPrimaryTab } from '../lib/tabNavigation';
import { t } from '../lib/i18n';
import styles from './Home.module.css';

const HomeNewReleases = lazy(() => import('../components/HomeNewReleases'));

function legacySavedTarget(saved: unknown): string | undefined {
  if (saved === 'bookmarks') return '/bookmarks';
  if (saved === 'albums') return '/bookmarks/albums';
  if (saved === 'artists') return '/bookmarks/artists';
  return undefined;
}

/** Main-shell landing page. */
export default function Home() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const redirectTo = () => legacySavedTarget(params.saved);
  createEffect(() => {
    const target = redirectTo();
    if (target) navigate(target, { replace: true });
  });
  const shortcuts = [
    ...libraryViews.slice(0, 3),
    ...['/favourites', '/playlists', '/podcasts'].map(href => navigationItems.find(item => item.href === href)!),
  ];
  return (
    <Show when={!redirectTo()}>
      <div class="view">
        <ViewHeader title={t('nav.home')} onTitleTap={() => reselectPrimaryTab('/')} />
        <div class={styles.body} ref={element => registerPrimaryScroll(element)} data-primary-scroll>
          <section aria-label={t('savedEntities.library')} class={styles.library}>
            <h2>{t('savedEntities.library')}</h2>
            <div class={styles.shortcuts}><For each={shortcuts}>{item =>
              <MusicLink path={item.href} class={styles.shortcut}><span aria-hidden="true">{item.icon()}</span>{item.label()}</MusicLink>
            }</For></div>
          </section>
          <SavedEntities />
          <HomeNewReleases />
        </div>
      </div>
    </Show>
  );
}
