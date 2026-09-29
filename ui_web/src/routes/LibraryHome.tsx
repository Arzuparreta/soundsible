import { For, Show } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { ViewHeader } from '../components/ViewHeader';
import SavedEntities from '../components/SavedEntities';
import { MusicLink } from '../components/MusicLinks';
import { navigationItems, libraryViews } from '../components/primaryNavigation';
import { useAppBar } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { reselectPrimaryTab } from '../lib/tabNavigation';
import { t } from '../lib/i18n';
import styles from './LibraryHome.module.css';

/** Main-shell landing page. NORMAL/DJ retain their independent music browser. */
export default function LibraryHome() {
  const [params] = useSearchParams();
  const kind = () => params.saved === 'albums' ? 'album' : params.saved === 'artists' ? 'artist' : undefined;
  useAppBar({ title: () => t('nav.library'), onTitleTap: () => reselectPrimaryTab('/') });
  const shortcuts = [
    ...libraryViews.slice(0, 3),
    ...['/favourites', '/playlists', '/podcasts'].map(href => navigationItems.find(item => item.href === href)!),
  ];
  return <div class="view">
    <Show when={desktopShell()}><ViewHeader title={t('nav.library')} onTitleTap={() => reselectPrimaryTab('/')} /></Show>
    <div class={styles.body} ref={element => registerPrimaryScroll(element)} data-primary-scroll>
      <Show when={!kind()} fallback={<MusicLink class={styles.back} path="/">← {t('savedEntities.back')}</MusicLink>}>
        <section aria-label={t('savedEntities.library')} class={styles.library}>
          <h2>{t('savedEntities.library')}</h2>
          <div class={styles.shortcuts}><For each={shortcuts}>{item =>
            <MusicLink path={item.href} class={styles.shortcut}><span aria-hidden="true">{item.icon()}</span>{item.label()}</MusicLink>
          }</For></div>
        </section>
      </Show>
      <SavedEntities kind={kind()} expanded={!!kind()} />
    </div>
  </div>;
}
