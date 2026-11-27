import { For, Show } from 'solid-js';
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
  glyph: string;
}

export function TvRail(props: TvRailProps) {
  const focus = useTvFocus();

  const hasSession = () => Boolean(state.playback.currentTrack || resumeState());

  const items = (): RailDestination[] => {
    const base: RailDestination[] = [
      { id: 'rail-home', routeName: 'home', hash: '#/home', label: () => t('tv.nav.home'), glyph: '⌂' },
      { id: 'rail-search', routeName: 'search', hash: '#/search', label: () => t('tv.nav.search'), glyph: '⌕' },
      { id: 'rail-library', routeName: 'library', hash: '#/library', label: () => t('tv.nav.library'), glyph: '☷' },
    ];
    if (hasSession()) {
      base.push({
        id: 'rail-now-playing',
        routeName: 'now-playing',
        hash: '#/now-playing',
        label: () => t('tv.nav.nowPlaying'),
        glyph: '♪',
      });
    }
    base.push({
      id: 'rail-account',
      routeName: 'account',
      hash: '#/account',
      label: () => t('tv.nav.account'),
      glyph: '☺',
    });
    return base;
  };

  return (
    <aside
      class={styles.tvRail}
      classList={{ [styles.tvRailExpanded]: focus.inRail() }}
      aria-label={t('tv.title')}
    >
      <div class={styles.tvBrand} aria-hidden="true">
        <span>S</span>
        <Show when={focus.inRail()}>
          <span>{t('tv.title')}</span>
        </Show>
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
                class={styles.tvRailItem}
                classList={{
                  [styles.tvFocusTarget]: true,
                  [styles.tvRailItemSelected]: isSelected(),
                }}
                onClick={() => props.onSelect(item.hash)}
              >
                <span aria-hidden="true">{item.glyph}</span>
                <Show when={focus.inRail()}>
                  <span>{item.label()}</span>
                </Show>
              </Control>
            );
          }}
        </For>
      </nav>
    </aside>
  );
}
