import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
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

/**
 * The inside of the settings window, and the only settings shell there is.
 *
 * Desktop keeps a rail of submenus beside the open one; mobile pushes one
 * submenu at a time over the index. Both compositions come from the same tree
 * and the same registry — the difference is `desktopShell()`, a boolean, not a
 * stylesheet full of crossed-out `display: none`. Which is what makes the two
 * layouts stay in step: there is no second layout to forget to update.
 */

export interface SettingsShellProps {
  /** The open submenu's id, or null for the index. Owned by the caller so the
   *  window can reopen where it was left. */
  section: string | null;
  onSectionChange: (id: string | null) => void;
  onClose: () => void;
}

function CloseButton(props: { onClose: () => void }) {
  return (
    <button
      type="button"
      class={styles.close}
      aria-label={t('settings.close')}
      onClick={() => props.onClose()}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M7 7l10 10M17 7L7 17" />
      </svg>
    </button>
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

  const current = createMemo(() => findSection(props.section ?? undefined) ?? null);
  const matches = createMemo(() => matchSections(visibleSections(), query()));
  const groups = createMemo(() => groupSections(visibleSections(), SETTINGS_GROUPS));

  createEffect(() => {
    // A stale id — an old deep link, or an admin-only submenu on an account
    // that just lost admin — must land on the index, not on an empty pane.
    if (props.section && !current()) {
      props.onSectionChange(null);
      return;
    }
    // Desktop is a split view: an empty right-hand pane is a dead pane, so the
    // rail always has a selection. Mobile starts on the index by design.
    if (desktopShell() && !current()) {
      props.onSectionChange(visibleSections()[0]?.id ?? null);
    }
  });

  const select = (id: string) => {
    setQuery('');
    props.onSectionChange(id);
  };

  return (
    <div class={styles.window} data-layout={desktopShell() ? 'split' : 'stack'}>
      <Show when={desktopShell() || !current()}>
        <div class={styles.rail}>
          <div class={styles.railHead}>
            <CloseButton onClose={props.onClose} />
            <Show when={!desktopShell()}>
              <h1 class={styles.railTitle}>{t('settings.title')}</h1>
            </Show>
          </div>

          <div class={styles.railScroll}>
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
                              current={section.id === props.section}
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
                          current={section.id === props.section}
                          compact={desktopShell()}
                          onSelect={select}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              )}
            </Show>
          </div>
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
              <h1 class={styles.detailTitle}>{section.title()}</h1>
              <Show when={!desktopShell()}>
                <CloseButton onClose={props.onClose} />
              </Show>
            </header>
            <div class={styles.detailScroll}>{section.content()}</div>
          </section>
        )}
      </Show>
    </div>
  );
}
