import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from 'solid-js';
import { ViewHeader } from './ViewHeader';
import { useAppBar } from '../lib/appBar';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { t } from '../lib/i18n';
import { SearchField } from './SearchField';
import { Chevron } from './SettingsRows';
import {
  SETTINGS_GROUPS,
  findSection,
  settingsCapabilities,
  visibleSections,
  type SettingsSection,
} from './SettingsSections';
import { groupSections, searchSettings, type SettingsSearchResult } from '../lib/settingsIndex';
import type { MatchRange } from '../lib/settingsSearch';
import { createResponsiveTap } from '../lib/responsiveTap';
import { desktopShell } from '../lib/shellLayout';
import styles from './SettingsShell.module.css';

/** Categories and detail live in the app's route outlet at every size. */
export interface SettingsShellProps {
  section: string | null;
  /** The settings search, owned by the URL so going back returns to the results. */
  query: string;
  /** The setting a search result asked to land on, if any. */
  setting: string | null;
  onQueryChange: (query: string) => void;
  onSectionChange: (id: string | null, setting?: string) => void;
}

type SearchResult = SettingsSearchResult<SettingsSection>;

/** How long a landing waits for a submenu that loads its rows. */
const LANDING_WAIT_MS = 1500;
/** How long the landed row stays marked. Matches the stylesheet's pulse. */
const FLASH_MS = 1800;

/* Where focus goes on landing. Text fields are left alone: focusing one would
   open a keyboard nobody asked for. */
const LANDING_FOCUS =
  'summary, button:not(:disabled), select, a[href], input[type="checkbox"], input[type="range"]';

function ScrollArea(props: {
  primary: boolean;
  class: string;
  ready?: () => boolean;
  landing?: () => number | null;
  ref?: (element: HTMLDivElement) => void;
  children: JSX.Element;
}) {
  let element!: HTMLDivElement;
  // Switching between the index and split view also switches which scroller
  // participates in route history. The effect cleans up the old registration.
  createEffect(() => {
    if (props.primary) registerPrimaryScroll(element, props.ready, props.landing);
  });
  return (
    <div
      ref={(el) => {
        element = el;
        props.ref?.(el);
      }}
      class={props.class}
      data-primary-scroll={props.primary ? '' : undefined}
    >
      {props.children}
    </div>
  );
}

function CategoryRow(props: {
  section: SettingsSection;
  current: boolean;
  compact: boolean;
  onSelect: (id: string) => void;
}) {
  // Mobile WebKit can swallow the synthetic click while it unwinds kinetic
  // scrolling, and this list is inside a scroller. Activate on pointerup.
  const tap = createResponsiveTap({ onTap: () => props.onSelect(props.section.id) });

  return (
    <button
      type="button"
      class={styles.cat}
      classList={{ [styles.catCurrent]: props.current }}
      aria-current={props.current ? 'true' : undefined}
      data-pressable
      {...tap}
    >
      <span class={styles.catIcon} data-tone={props.section.tone}>
        {props.section.icon()}
      </span>
      <span class={styles.catText}>
        <span class={styles.catTitle}>{props.section.title()}</span>
        <Show when={!props.compact}>
          <span class={styles.catBlurb}>{props.section.blurb()}</span>
        </Show>
      </span>
      <Show when={!props.compact}>
        <Chevron class={styles.catChevron} />
      </Show>
    </button>
  );
}

/** `text` with the matched ranges marked. */
function Highlight(props: { text: string; ranges: MatchRange[] }) {
  const parts = createMemo(() => {
    const out: { text: string; mark: boolean }[] = [];
    let at = 0;
    for (const [start, end] of props.ranges) {
      if (start > at) out.push({ text: props.text.slice(at, start), mark: false });
      out.push({ text: props.text.slice(start, end), mark: true });
      at = end;
    }
    if (at < props.text.length) out.push({ text: props.text.slice(at), mark: false });
    return out;
  });
  return (
    <For each={parts()}>
      {(part) => (part.mark ? <mark class={styles.mark}>{part.text}</mark> : part.text)}
    </For>
  );
}

function ResultRow(props: {
  result: SearchResult;
  current: boolean;
  compact: boolean;
  onOpen: (result: SearchResult) => void;
  onKeyDown: JSX.EventHandler<HTMLButtonElement, KeyboardEvent>;
}) {
  const tap = createResponsiveTap({ onTap: () => props.onOpen(props.result) });

  return (
    <button
      type="button"
      class={`${styles.cat} ${styles.result}`}
      classList={{ [styles.catCurrent]: props.current }}
      aria-current={props.current ? 'true' : undefined}
      data-pressable
      data-settings-result
      onKeyDown={props.onKeyDown}
      {...tap}
    >
      <span class={styles.catIcon} data-tone={props.result.section.tone}>
        {props.result.section.icon()}
      </span>
      <span class={styles.catText}>
        <span class={styles.catTitle}>
          <Highlight text={props.result.label} ranges={props.result.ranges} />
        </span>
        <Show when={props.result.path}>
          <span class={styles.resultPath}>{props.result.path}</span>
        </Show>
      </span>
      <Show when={!props.compact}>
        <Chevron class={styles.catChevron} />
      </Show>
    </button>
  );
}

function findAnchor(root: HTMLElement, id: string): HTMLElement | null {
  // Compared rather than put in a selector: the id comes from the URL.
  for (const candidate of root.querySelectorAll<HTMLElement>('[data-setting]')) {
    if (candidate.dataset.setting === id) return candidate;
  }
  return null;
}

/**
 * The open submenu. When a search result sent us here, wait for its row —
 * some submenus load theirs — then land on it, open whatever disclosure hides
 * it, and mark it for a moment so the eye finds it.
 */
function Detail(props: { section: SettingsSection; setting: string | null; onBack: () => void }) {
  let scroller: HTMLDivElement | undefined;
  const [target, setTarget] = createSignal<HTMLElement | null>(null);
  const [gaveUp, setGaveUp] = createSignal(false);

  createEffect(() => {
    const id = props.setting;
    setTarget(null);
    setGaveUp(false);
    if (!id || !scroller) return;
    const root = scroller;
    const look = () => {
      const anchor = findAnchor(root, id);
      if (anchor) setTarget(anchor);
      return !!anchor;
    };
    if (look()) return;
    const observer = new MutationObserver(() => {
      if (look()) stop();
    });
    const timer = window.setTimeout(() => {
      stop();
      setGaveUp(true);
    }, LANDING_WAIT_MS);
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
    observer.observe(root, { childList: true, subtree: true });
    onCleanup(stop);
  });

  createEffect(() => {
    const anchor = target();
    if (!anchor) return;
    const disclosure = anchor.closest('details');
    if (disclosure && !disclosure.open) disclosure.open = true;
    anchor.setAttribute('data-setting-flash', '');
    const timer = window.setTimeout(() => anchor.removeAttribute('data-setting-flash'), FLASH_MS);
    // Focus follows a landing, not a window resize.
    if (untrack(desktopShell)) {
      const control = anchor.matches(LANDING_FOCUS)
        ? anchor
        : anchor.querySelector<HTMLElement>(LANDING_FOCUS);
      control?.focus({ preventScroll: true });
    }
    onCleanup(() => {
      window.clearTimeout(timer);
      anchor.removeAttribute('data-setting-flash');
    });
  });

  const ready = () => !props.setting || !!target() || gaveUp();
  /** A third of the way down, so the row reads with its context above it. */
  const landing = () => {
    const anchor = target();
    if (!anchor || !scroller) return null;
    const offset =
      anchor.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      scroller.clientHeight / 3;
    return Math.max(0, Math.round(offset));
  };

  // On the touch shell a section is a page of its own: its name and the way
  // back to the index are the top bar's. Side by side, it is a pane under the
  // page's title.
  useAppBar({ title: () => props.section.title(), back: () => props.onBack() });

  return (
    <section class={styles.detail}>
      <Show when={desktopShell()}>
        <header class={styles.detailHead}>
          <h2 class={styles.detailTitle}>{props.section.title()}</h2>
        </header>
      </Show>
      <ScrollArea
        primary={true}
        class={styles.detailScroll}
        ready={ready}
        landing={landing}
        ref={(element) => (scroller = element)}
      >
        {props.section.content()}
      </ScrollArea>
    </section>
  );
}

export default function SettingsShell(props: SettingsShellProps) {
  let input: HTMLInputElement | undefined;
  let results: HTMLDivElement | undefined;

  const current = createMemo(() => props.section
    ? findSection(props.section) ?? null
    : desktopShell() ? visibleSections()[0] ?? null : null);
  const matches = createMemo(() =>
    searchSettings(visibleSections(), settingsCapabilities(), props.query),
  );
  const groups = createMemo(() => groupSections(visibleSections(), SETTINGS_GROUPS));

  const select = (id: string) => props.onSectionChange(id);
  const open = (result: SearchResult) =>
    props.onSectionChange(result.section.id, result.setting?.id);

  const isCurrent = (result: SearchResult) =>
    result.section.id === current()?.id &&
    (result.setting ? result.setting.id === props.setting : !props.setting);

  const resultButtons = () =>
    Array.from(results?.querySelectorAll<HTMLButtonElement>('[data-settings-result]') ?? []);

  const onFieldKey: JSX.EventHandler<HTMLInputElement, KeyboardEvent> = (event) => {
    const list = matches();
    if (!list?.length || event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      open(list[0]);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      resultButtons()[0]?.focus();
    }
  };

  const onResultKey: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = resultButtons();
    const index = buttons.indexOf(event.currentTarget);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) input?.focus();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  };

  return (
    <div class={`view ${styles.page}`} data-settings-page data-layout={desktopShell() ? 'split' : 'stack'}>
      <Show when={desktopShell() || !current()}>
        <div class={styles.rail}>
          <ViewHeader title={t('settings.title')} />
          <ScrollArea primary={!desktopShell()} class={styles.railScroll}>
            <SearchField
              value={props.query}
              placeholder={t('settings.searchPlaceholder')}
              inputRef={(element) => (input = element)}
              onInput={props.onQueryChange}
              onKeyDown={onFieldKey}
            />

            <Show
              when={matches()}
              fallback={
                <For each={groups()}>
                  {(group) => (
                    <section class={styles.group}>
                      <h2 class={styles.groupLabel}>{group.label}</h2>
                      <div class={styles.catList}>
                        <For each={group.sections}>
                          {(section) => (
                            <CategoryRow
                              section={section}
                              current={section.id === current()?.id}
                              compact={desktopShell()}
                              onSelect={select}
                            />
                          )}
                        </For>
                      </div>
                    </section>
                  )}
                </For>
              }
            >
              {(list) => (
                <>
                  <p class={styles.srOnly} aria-live="polite">
                    {list().length === 1
                      ? t('settings.searchCountOne')
                      : t('settings.searchCount', { count: list().length })}
                  </p>
                  <Show
                    when={list().length > 0}
                    fallback={
                      <p class={styles.empty}>{t('settings.searchNoResults', { query: props.query })}</p>
                    }
                  >
                    <div
                      ref={results}
                      class={styles.catList}
                      role="group"
                      aria-label={t('settings.searchResults')}
                    >
                      <For each={list()}>
                        {(result) => (
                          <ResultRow
                            result={result}
                            current={isCurrent(result)}
                            compact={desktopShell()}
                            onOpen={open}
                            onKeyDown={onResultKey}
                          />
                        )}
                      </For>
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </ScrollArea>
        </div>
      </Show>

      <Show when={current()} keyed>
        {(section) => (
          <Detail
            section={section}
            setting={props.setting}
            onBack={() => props.onSectionChange(null)}
          />
        )}
      </Show>
    </div>
  );
}
