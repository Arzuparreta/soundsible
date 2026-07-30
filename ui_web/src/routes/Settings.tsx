import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { A, useNavigate, useParams } from '@solidjs/router';
import { t } from '../lib/i18n';
import { SearchField } from '../components/SearchField';
import { Chevron } from '../components/SettingsRows';
import {
  SETTINGS_GROUPS,
  findSection,
  visibleSections,
  type SettingsSection,
} from '../components/SettingsSections';
import { groupSections, matchSections } from '../lib/settingsIndex';
import { navigateBackOr, registerPrimaryScroll } from '../lib/scrollHistory';
import { createResponsiveTap } from '../lib/responsiveTap';
import styles from './Settings.module.css';

/**
 * Settings is an index of submenus, not a wall of switches. Mobile pushes one
 * submenu at a time; desktop shows the index beside the open one. Both read the
 * same registry, so a setting exists in exactly one place with one label.
 */
function CategoryRow(props: { section: SettingsSection; current: boolean }) {
  const navigate = useNavigate();
  const href = () => `/settings/${props.section.id}`;
  const tap = createResponsiveTap({
    onTap: (event) => {
      event.preventDefault();
      navigate(href());
    },
  });

  return (
    <A
      href={href()}
      class={styles.cat}
      classList={{ [styles.catCurrent]: props.current }}
      aria-current={props.current ? 'page' : undefined}
      data-pressable
      {...tap}
    >
      <span class={styles.catIcon} data-tone={props.section.tone}>
        {props.section.icon()}
      </span>
      <span class={styles.catText}>
        <span class={styles.catTitle}>{props.section.title()}</span>
        <span class={styles.catBlurb}>{props.section.blurb()}</span>
      </span>
      <Chevron class={styles.catChevron} />
    </A>
  );
}

export default function Settings() {
  const params = useParams();
  const navigate = useNavigate();
  const [query, setQuery] = createSignal('');

  const active = () => findSection(params.section);

  // A stale bookmark or an admin-only id on a member account must land on the
  // index rather than on an empty pane.
  createEffect(() => {
    if (params.section && !active()) navigate('/settings', { replace: true });
  });

  const matches = createMemo(() => matchSections(visibleSections(), query()));
  const groups = createMemo(() => groupSections(visibleSections(), SETTINGS_GROUPS));

  return (
    <div class="view">
      <header class={styles.head}>
        <Show when={active()}>
          <button
            type="button"
            class={styles.back}
            aria-label={t('common.back')}
            onClick={() => navigateBackOr(navigate, '/settings')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        </Show>
        {/* One of the two is always display:none, so only one reaches the
            accessibility tree: the open submenu on mobile, the page on desktop. */}
        <h1 class={styles.title}>
          <span class={styles.titleContext}>{active()?.title() ?? t('settings.title')}</span>
          <span class={styles.titleRoot}>{t('settings.title')}</span>
        </h1>
      </header>

      <div
        ref={(element) => registerPrimaryScroll(element)}
        class={styles.scroll}
        data-view={active() ? 'detail' : 'index'}
        data-primary-scroll
      >
        <div class={styles.index}>
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
                          <CategoryRow section={section} current={section.id === params.section} />
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
                      <CategoryRow section={section} current={section.id === params.section} />
                    )}
                  </For>
                </div>
              </Show>
            )}
          </Show>
        </div>

        <Show
          when={active()}
          keyed
          fallback={
            <div class={styles.placeholder}>
              <p class={styles.placeholderTitle}>{t('settings.pickSection')}</p>
              <p class={styles.placeholderBody}>{t('settings.pickSectionBody')}</p>
            </div>
          }
        >
          {(section) => (
            <div class={styles.detail}>
              <h2 class={styles.detailTitle}>{section.title()}</h2>
              {section.content()}
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
