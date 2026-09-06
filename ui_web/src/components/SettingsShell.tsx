import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { ViewHeader } from './ViewHeader';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { t } from '../lib/i18n';
import { SearchField } from './SearchField';
import { Chevron } from './SettingsRows';
import {
  SETTINGS_GROUPS,
  findSection,
  visibleSections,
  type SettingsSection,
} from './SettingsSections';
import { groupSections, matchSections } from '../lib/settingsIndex';
import { createResponsiveTap } from '../lib/responsiveTap';
import { desktopShell } from '../lib/shellLayout';
import styles from './SettingsShell.module.css';

/** Categories and detail live in the app's route outlet at every size. */
export interface SettingsShellProps {
  section: string | null;
  onSectionChange: (id: string | null) => void;
}

function ScrollArea(props: { primary: boolean; class: string; children: JSX.Element }) {
  let element!: HTMLDivElement;
  // Switching between the index and split view also switches which scroller
  // participates in route history. The effect cleans up the old registration.
  createEffect(() => {
    if (props.primary) registerPrimaryScroll(element);
  });
  return (
    <div ref={element} class={props.class} data-primary-scroll={props.primary ? '' : undefined}>
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

export default function SettingsShell(props: SettingsShellProps) {
  const [query, setQuery] = createSignal('');

  const current = createMemo(() => props.section
    ? findSection(props.section) ?? null
    : desktopShell() ? visibleSections()[0] ?? null : null);
  const matches = createMemo(() => matchSections(visibleSections(), query()));
  const groups = createMemo(() => groupSections(visibleSections(), SETTINGS_GROUPS));

  const select = (id: string) => {
    setQuery('');
    props.onSectionChange(id);
  };

  return (
    <div class={`view ${styles.page}`} data-settings-page data-layout={desktopShell() ? 'split' : 'stack'}>
      <Show when={desktopShell() || !current()}>
        <div class={styles.rail}>
          <ViewHeader title={t('settings.title')} />
          <ScrollArea primary={!desktopShell()} class={styles.railScroll}>
            <SearchField
              value={query()}
              placeholder={t('settings.searchPlaceholder')}
              onInput={setQuery}
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
                <Show
                  when={list().length > 0}
                  fallback={
                    <p class={styles.empty}>{t('settings.searchNoResults', { query: query() })}</p>
                  }
                >
                  <div class={styles.catList}>
                    <For each={list()}>
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
                </Show>
              )}
            </Show>
          </ScrollArea>
        </div>
      </Show>

      <Show when={current()} keyed>
        {(section) => (
          <section class={styles.detail}>
            <header class={styles.detailHead}>
              <Show when={!desktopShell()}>
                <button
                  type="button"
                  class={styles.back}
                  aria-label={t('common.back')}
                  onClick={() => props.onSectionChange(null)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
              </Show>
              <Dynamic component={desktopShell() ? 'h2' : 'h1'} class={styles.detailTitle}>
                {section.title()}
              </Dynamic>
            </header>
            <ScrollArea primary={true} class={styles.detailScroll}>{section.content()}</ScrollArea>
          </section>
        )}
      </Show>
    </div>
  );
}
