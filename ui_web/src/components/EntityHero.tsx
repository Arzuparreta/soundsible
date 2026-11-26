import { createSignal, Show, type JSX } from 'solid-js';
import { Control } from '../design/Control';
import { useAppBar } from '../lib/appBar';
import { coverGradient } from '../lib/cover';
import { t } from '../lib/i18n';
import { createResponsiveTap } from '../lib/responsiveTap';
import { desktopShell } from '../lib/shellLayout';
import type { SearchRevealState } from './SearchReveal';
import { CoverImage } from './CoverImage';
import { BackIcon } from './icons';
import hero from './EntityHero.module.css';

/** Identity and Back stay with the artwork. Each entity owns its own controls. */
export function EntityHero(props: {
  name: string;
  back: () => void;
  backLabel: string;
  variant?: 'compact' | 'podcast';
  headerClass?: string;
  art: JSX.Element;
  openMenu?: () => void;
  corner?: JSX.Element;
  children?: JSX.Element;
  metadata?: JSX.Element;
  search?: SearchRevealState;
}) {
  const [heading, setHeading] = createSignal<HTMLElement>();
  useAppBar({ title: () => props.name, back: props.back, backLabel: () => props.backLabel, heading, search: () => props.search });

  const openMenu = () => props.openMenu?.();
  const tap = createResponsiveTap({ onTap: openMenu, onLongPress: openMenu });
  const context = (event: MouseEvent) => { event.preventDefault(); openMenu(); };

  return <header class={`${hero.header} ${props.headerClass ?? ''}`}>
    <Show when={desktopShell()}>
      <Control class={hero.back} type="button" aria-label={props.backLabel} onClick={() => props.back()}>
        <BackIcon size={20} />
      </Control>
    </Show>
    <div class={hero.hero} classList={{ [hero.compact]: props.variant === 'compact', [hero.podcast]: props.variant === 'podcast', [hero.hasCorner]: Boolean(props.corner) }}>
      {props.art}
      <div class={hero.identity}>
        <h1 ref={setHeading} class={hero.title}>
          <Show when={props.openMenu} fallback={props.name}>
            <Control type="button" class={hero.titleButton} data-testid="collection-header-name"
              aria-haspopup="dialog" title={t('savedEntities.options')} {...tap} onContextMenu={context}>{props.name}</Control>
          </Show>
        </h1>
        {props.metadata}
      </div>
      <Show when={props.corner}><div class={hero.corner}>{props.corner}</div></Show>
      {props.children}
    </div>
  </header>;
}

export function EntityMenuCover(props: { name: string; cover?: string; round?: boolean; onOpen: () => void }) {
  const open = () => props.onOpen();
  const tap = createResponsiveTap({ onTap: open, onLongPress: open });
  return <Control type="button" class={hero.art} classList={{ [hero.round]: props.round }} data-testid="collection-header-cover"
    aria-label={`${t('savedEntities.options')}: ${props.name}`} aria-haspopup="dialog"
    {...tap} onContextMenu={event => { event.preventDefault(); open(); }} style={{ background: coverGradient(props.name) }}>
    <CoverImage src={props.cover} eager />
    <Show when={!props.cover}><span class={hero.initial} aria-hidden="true">{(props.name[0] ?? '?').toUpperCase()}</span></Show>
  </Control>;
}
