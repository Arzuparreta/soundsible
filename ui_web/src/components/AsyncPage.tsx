import Button from './Button';
import { createSignal, ErrorBoundary, Match, onCleanup, onMount, Show, Switch, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { t } from '../lib/i18n';
import { ViewHeader } from './ViewHeader';
import {
  SkeletonCards,
  SkeletonHeading,
  SkeletonHome,
  SkeletonRegion,
  SkeletonRows,
  SkeletonToolbar,
  skeletonPageStyles as s,
} from '../design/Skeleton';
import { EmptyState } from './EmptyState';

export type AsyncPageShape =
  | 'rows'
  | 'songs'
  | 'favourites'
  | 'cards'
  | 'albums'
  | 'artists'
  | 'playlists'
  | 'podcasts'
  | 'bookmarks'
  | 'bookmarks-albums'
  | 'bookmarks-artists'
  | 'home'
  | 'search'
  | 'downloads'
  | 'artist'
  | 'album'
  | 'playlist-detail'
  | 'podcast-show'
  | 'settings';

interface StandardShapeConfig {
  regionClass?: string;
  bodyClass?: string;
  toolbar?: { always?: boolean; meta?: boolean; actions?: boolean };
  headingClass?: string;
  rows?: { count: number; indexed?: boolean };
  cards?: { count: number; shape?: 'square' | 'round'; lines?: 1 | 2 | 3; padded?: boolean };
}

const STANDARD_SHAPES: Partial<Record<AsyncPageShape, StandardShapeConfig>> = {
  songs: { toolbar: { meta: true, actions: true }, rows: { count: 12 } },
  favourites: { regionClass: s.pagePadFavourites, toolbar: { meta: true }, rows: { count: 12 } },
  albums: { toolbar: { meta: true, actions: true }, cards: { count: 12, lines: 3, padded: true } },
  artists: { toolbar: { meta: true }, cards: { count: 12, shape: 'round', lines: 2, padded: true } },
  playlists: { toolbar: { actions: true }, bodyClass: s.pagePadPlaylists, cards: { count: 12, lines: 2 } },
  podcasts: { toolbar: { actions: true }, bodyClass: s.pagePadPodcasts, headingClass: s.podcastsHeading, cards: { count: 12, lines: 2 } },
  downloads: { regionClass: s.pagePadDownloads, bodyClass: s.downloadsColumn, rows: { count: 4 } },
  artist: { regionClass: s.pagePadEntity, toolbar: {}, rows: { count: 6, indexed: true } },
  album: { regionClass: s.pagePadEntity, toolbar: {}, rows: { count: 8, indexed: true } },
  'playlist-detail': { regionClass: s.pagePadEntity, toolbar: { meta: true }, rows: { count: 10 } },
  'podcast-show': { regionClass: s.pagePadEntity, toolbar: {}, rows: { count: 8 } },
  settings: { regionClass: s.pagePad, toolbar: { always: true }, rows: { count: 5 } },
};

function wrapOptional(className: string | undefined, child: JSX.Element): JSX.Element {
  return className ? <div class={className}>{child}</div> : child;
}

function PageSkeleton(props: { shape: AsyncPageShape }) {
  const standard = () => STANDARD_SHAPES[props.shape];

  return (
    <Show when={standard()} keyed fallback={
      <Switch fallback={<SkeletonRows />}>
        <Match when={props.shape === 'cards'}><SkeletonCards padded /></Match>
        <Match when={props.shape === 'home'}><SkeletonHome /></Match>
        <Match when={props.shape === 'bookmarks' || props.shape === 'bookmarks-albums' || props.shape === 'bookmarks-artists'}>
          <SkeletonRegion>
            <SkeletonToolbar />
            <div class={s.pagePadBookmarks}>
              <div class={`${s.bone} ${s.bookmarksBackBone}`} aria-hidden="true" />
              <Show when={props.shape === 'bookmarks'} fallback={
                <div class={s.stackGapMd}>
                  <SkeletonHeading />
                  <SkeletonCards
                    count={12}
                    shape={props.shape === 'bookmarks-artists' ? 'round' : 'square'}
                    lines={props.shape === 'bookmarks-albums' ? 2 : 1}
                    decorative
                  />
                </div>
              }>
                <div class={s.stackGapLg}>
                  <div class={s.stackGapMd}><SkeletonHeading /><SkeletonCards count={6} shape="round" lines={1} decorative /></div>
                  <div class={s.stackGapMd}><SkeletonHeading /><SkeletonCards count={6} lines={2} decorative /></div>
                </div>
              </Show>
            </div>
          </SkeletonRegion>
        </Match>
        <Match when={props.shape === 'search'}>
          <SkeletonRegion>
            <SkeletonToolbar always />
            <div class={`${s.pagePad} ${s.stackGapLg}`}>
              <div class={s.stackGapMd}><SkeletonHeading action /><SkeletonCards layout="rail" shape="round" lines={2} bleedOnTouch decorative /></div>
              <div class={s.stackGapMd}><SkeletonHeading action /><SkeletonCards layout="rail" lines={3} bleedOnTouch decorative /></div>
              <div class={s.stackGapMd}><SkeletonHeading subtitle action /><SkeletonRows count={5} decorative /></div>
            </div>
          </SkeletonRegion>
        </Match>
      </Switch>
    }>
      {(cfg) => (
        <SkeletonRegion class={cfg.regionClass}>
          <Show when={cfg.toolbar}>{(toolbar) => <SkeletonToolbar {...toolbar()} />}</Show>
          {wrapOptional(cfg.bodyClass, <>
            <Show when={cfg.headingClass}><SkeletonHeading class={cfg.headingClass} /></Show>
            <Show when={cfg.rows}>{(rows) => <SkeletonRows {...rows()} decorative />}</Show>
            <Show when={cfg.cards}>{(cards) => <SkeletonCards {...cards()} decorative />}</Show>
          </>)}
        </SkeletonRegion>
      )}
    </Show>
  );
}

/** Route modules load independently of router transitions. The destination and
 * its header commit immediately; a slow chunk never keeps the old page alive.
 * Cache code, not mounted pages or account data. Failed imports remain retryable. */
export function asyncPage(load: () => Promise<{ default: Component }>, title: () => string,
  shape: AsyncPageShape = 'rows'): Component {
  let cached: Component | undefined;
  let flight: Promise<Component> | undefined;
  const resolve = () => flight ??= load().then(module => cached = module.default)
    .finally(() => { flight = undefined; });
  return () => {
    const [page, setPage] = createSignal<Component | undefined>(cached);
    const [failed, setFailed] = createSignal(false);
    let disposed = false;
    onCleanup(() => { disposed = true; });
    const retry = () => {
      setFailed(false);
      void resolve().then(component => {
        if (!disposed) setPage(() => component);
      }, () => { if (!disposed) setFailed(true); });
    };
    onMount(() => { if (!page()) retry(); });
    return <Show when={page()} keyed fallback={
      <div class="view">
        <ViewHeader title={title()} />
        <Show when={!failed()} fallback={<EmptyState tone="danger">
          {t('common.loadFailed')} <Button variant="secondary" onClick={retry}>{t('common.retry')}</Button>
        </EmptyState>}>
          <div class="page-loading" aria-busy="true" tabIndex={0}>
            <PageSkeleton shape={shape} />
          </div>
        </Show>
      </div>
    }>{component => <ErrorBoundary fallback={(_error, reset) => <div class="view">
      <ViewHeader title={title()} />
      <EmptyState tone="danger">{t('common.loadFailed')} <Button variant="secondary" onClick={reset}>{t('common.retry')}</Button></EmptyState>
    </div>}><Dynamic component={component} /></ErrorBoundary>}</Show>;
  };
}
