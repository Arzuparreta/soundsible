import { Show, type JSX } from 'solid-js';
import { t } from '../lib/i18n';
import { libraryTab } from '../lib/libraryView';
import { NavigationMenuButton } from './NavigationMenu';
import styles from './MobileLibraryHeader.module.css';
export function MobileLibraryHeader(props: { favourites?: boolean; onSearch?: () => void; onViewChange?: () => void; actions?: JSX.Element }) {
  return <header class={styles.header} data-mobile-library-header>
    <NavigationMenuButton onViewChange={props.onViewChange} />
    <h1 style={{ flex: '1' }}>{props.favourites ? t('nav.favourites') : t(`library.${libraryTab()}` as 'library.songs')}</h1>
    <div class={styles.actions}><Show when={props.onSearch}><button type="button" aria-label={t('library.searchAction')} onClick={props.onSearch}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></svg></button></Show>{props.actions}</div>
  </header>;
}
