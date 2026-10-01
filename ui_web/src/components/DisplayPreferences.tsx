import { For, type JSX } from 'solid-js';
import { state } from '../stores/core';
import { visualPreferenceActions as actions } from '../stores/visualPreferences';
import { t } from '../lib/i18n';
import { openOverlay } from '../lib/overlay';
import type { InterfaceSize } from '../lib/visualPreferences';
import { settingAnchor, settingsRowStyles as rowStyles } from './SettingsRows';
import styles from './DisplayPreferences.module.css';

const SIZES: InterfaceSize[] = ['compact', 'normal', 'large'];

function sizeLabel(size: InterfaceSize): string {
  return t(`accessibility.size.${size}`);
}

export function DisplayPreferences(props: { heading?: boolean; onClose?: () => void } = {}) {
  const sizeIndex = () => SIZES.indexOf(state.interfaceSize);
  const setIndex = (raw: string) => {
    const next = SIZES[Math.max(0, Math.min(SIZES.length - 1, Number(raw)))];
    if (next) actions.setInterfaceSize(next);
  };

  return (
    <div class={styles.root}>
      {props.heading ? (
        <div class={styles.head}>
          <div>
            <h2 class={styles.title}>{t('accessibility.title')}</h2>
            <p class={styles.intro}>{t('accessibility.intro')}</p>
          </div>
          {props.onClose ? (
            <button
              type="button"
              class={styles.close}
              aria-label={t('common.close')}
              onClick={props.onClose}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}

      <div class={styles.sizeBlock} {...settingAnchor('interface-size')}>
        <div class={styles.fieldHead}>
          <span class={styles.label} id="interface-size-label">
            {t('accessibility.interfaceSize')}
          </span>
          <output class={styles.value} for="interface-size">
            {sizeLabel(state.interfaceSize)}
          </output>
        </div>
        <div class={styles.scale}>
          <div class={styles.letters} aria-hidden="true">
            <span>A</span>
            <span>A</span>
            <span>A</span>
          </div>
          <input
            id="interface-size"
            class={styles.range}
            type="range"
            min="0"
            max="2"
            step="1"
            value={sizeIndex()}
            aria-labelledby="interface-size-label"
            aria-valuetext={sizeLabel(state.interfaceSize)}
            style={{ '--size-step': `${sizeIndex() * 50}%` }}
            onInput={(event) => setIndex(event.currentTarget.value)}
          />
          <div class={styles.ticks}>
            <For each={SIZES}>
              {(size) => (
                <button
                  type="button"
                  class={styles.tick}
                  classList={{ [styles.tickActive]: state.interfaceSize === size }}
                  aria-pressed={state.interfaceSize === size}
                  onClick={() => actions.setInterfaceSize(size)}
                >
                  {sizeLabel(size)}
                </button>
              )}
            </For>
          </div>
        </div>
      </div>

      {/* The same row and switch as every other setting, driven by a native
          checkbox so the whole label toggles it. */}
      <label class={`${rowStyles.row} ${styles.contrastRow}`} {...settingAnchor('high-contrast')}>
        <span class={rowStyles.text}>
          <span class={rowStyles.label} id="high-contrast-label">
            {t('accessibility.highContrast')}
          </span>
          <span class={rowStyles.hint} id="high-contrast-note">
            {t('accessibility.highContrastNote')}
          </span>
        </span>
        <input
          class={rowStyles.switchInput}
          type="checkbox"
          checked={state.highContrast}
          aria-labelledby="high-contrast-label"
          aria-describedby="high-contrast-note"
          onChange={(event) => actions.setHighContrast(event.currentTarget.checked)}
        />
        <span class={rowStyles.switch} aria-hidden="true">
          <span class={rowStyles.knob} />
        </span>
      </label>
    </div>
  );
}

export function openDisplayPreferences(): () => void {
  return openOverlay(
    (close) => <DisplayPreferences heading onClose={close} />,
    { ariaLabel: t('accessibility.title') },
  );
}

export function AccessibilityButton(props: { class?: string }): JSX.Element {
  return (
    <button
      type="button"
      class={props.class}
      aria-label={t('accessibility.open')}
      title={t('accessibility.open')}
      onClick={openDisplayPreferences}
    >
      <span aria-hidden="true">Aa</span>
    </button>
  );
}
