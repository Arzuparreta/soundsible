import { For, type JSX } from 'solid-js';
import { BrandIcon } from '../../components/BrandIcon';
import { ArtistIcon, HomeIcon, NavigationSearchIcon, PlaylistIcon, QueueListIcon } from '../../components/icons';
import { NavigationItemContent } from '../../components/NavigationItemContent';
import navStyles from '../../components/NavigationMenu.module.css';
import { Control } from '../../design/Control';
import { t } from '../../lib/i18n';
import { resumeState, state } from '../../stores';
import { useTvFocus } from '../nav/spatial';
import type { TvRoute } from '../nav/router';
import styles from '../styles/tv.module.css';

interface TvRailProps {
  currentRoute: () => TvRoute;
  onSelect: (hash: string) => void;
}

interface RailDestination {
  id: string;
  routeName: TvRoute['name'];
  hash: string;
  label: () => string;
  icon: () => JSX.Element;
}

const destinations: readonly RailDestination[] = [
  { id: 'rail-home', routeName: 'home', hash: '#/home', label: () => t('tv.nav.home'), icon: HomeIcon },
  { id: 'rail-search', routeName: 'search', hash: '#/search', label: () => t('tv.nav.search'), icon: NavigationSearchIcon },
  { id: 'rail-library', routeName: 'library', hash: '#/library', label: () => t('tv.nav.library'), icon: () => <PlaylistIcon /> },
  { id: 'rail-now-playing', routeName: 'now-playing', hash: '#/now-playing', label: () => t('tv.nav.nowPlaying'), icon: () => <QueueListIcon /> },
  { id: 'rail-account', routeName: 'account', hash: '#/account', label: () => t('tv.nav.account'), icon: () => <ArtistIcon /> },
];

export function TvRail(props: TvRailProps) {
  const focus = useTvFocus();
  const hasSession = () => Boolean(state.playback.currentTrack || resumeState());
  const items = () => destinations.filter(item => item.routeName !== 'now-playing' || hasSession());

  return (
    <aside
      class={styles.tvRail}
      classList={{ [styles.tvRailExpanded]: focus.inRail() }}
      aria-label={t('tv.title')}
    >
      <div class={styles.tvBrand} aria-hidden="true">
        <BrandIcon />
        <span hidden={!focus.inRail()}>soundsible</span>
      </div>
      <nav
        class={styles.tvRailList}
        data-tv-group-container="tv-rail"
        data-tv-group-kind="rail"
        data-tv-group-order="0"
      >
        <For each={items()}>
          {(item, idx) => {
            const isSelected = () => props.currentRoute().name === item.routeName;
            const isFocused = () => focus.activeId() === item.id;
            return (
              <Control
                data-tv-id={item.id}
                data-tv-group="tv-rail"
                data-tv-index={String(idx())}
                data-tv-selected={isSelected() ? 'true' : undefined}
                data-tv-focused={isFocused() ? 'true' : undefined}
                aria-current={isSelected() ? 'page' : undefined}
                aria-label={item.label()}
                class={`${navStyles.item} ${styles.tvRailItem}`}
                classList={{
                  [styles.tvFocusTarget]: true,
                  [navStyles.active]: isSelected(),
                }}
                onClick={() => props.onSelect(item.hash)}
              >
                <NavigationItemContent icon={item.icon} label={item.label()} collapsed={!focus.inRail()} />
              </Control>
            );
          }}
        </For>
      </nav>
    </aside>
  );
}
