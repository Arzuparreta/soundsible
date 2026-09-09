import { type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { t } from '../lib/i18n';
import { libraryTab, setLibraryTab, setMobileLibrarySection } from '../lib/libraryView';
import { openActionMenu } from './ActionMenu';
import { ChevronDownIcon } from './icons';
import styles from './MobileLibraryHeader.module.css';

export function MobileLibraryHeader(props: { favourites?: boolean; onSearch?: () => void; onViewChange?: () => void; actions?: JSX.Element }) {
  const navigate = useNavigate();
  const current = () => props.favourites ? 'favourites' : libraryTab();
  const label = (view: string) => view === 'favourites' ? t('nav.favourites') :
    view === 'albums' ? t('library.albums') : view === 'artists' ? t('library.artists') : t('library.songs');
  const open = () => openActionMenu({
    title: t('nav.library'),
    actions: [
      ...['songs', 'albums', 'artists', 'favourites'].map((view) => ({
        label: label(view), selected: current() === view,
        onSelect: () => {
          props.onViewChange?.();
          setMobileLibrarySection(view === 'favourites' ? 'favourites' : 'library');
          if (view === 'favourites') { if (!props.favourites) navigate('/favourites'); }
          else {
            setLibraryTab(view);
            if (props.favourites) navigate('/');
          }
        },
      })),
      { label: t('library.searchAction'), onSelect: () => {
        setMobileLibrarySection('library');
        if (props.onSearch) props.onSearch();
        else navigate('/?search=1');
      } },
    ],
  }, true);
  return (
    <header class={styles.header} data-mobile-library-header>
      <h1><button type="button" onClick={(event) => { event.currentTarget.focus(); open(); }} aria-haspopup="dialog" data-pressable>
        <span class={styles.label}>{label(current())}</span><ChevronDownIcon class={styles.chevron} />
      </button></h1>
      <div class={styles.actions}>{props.actions}</div>
    </header>
  );
}
