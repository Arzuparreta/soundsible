import { For, type JSX } from 'solid-js';
import { actions, state } from '../stores';
import { t } from '../lib/i18n';
import { openOverlay } from '../lib/overlay';
import type { InterfaceSize } from '../lib/visualPreferences';
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

      <div class={styles.sizeBlock}>
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

      <label class={styles.contrastRow}>
        <span>
          <span class={styles.label}>{t('accessibility.highContrast')}</span>
          <span class={styles.note}>{t('accessibility.highContrastNote')}</span>
        </span>
        <input
          class={styles.nativeSwitch}
          type="checkbox"
          checked={state.highContrast}
          onChange={(event) => actions.setHighContrast(event.currentTarget.checked)}
        />
        <span class={styles.switch} aria-hidden="true">
          <span />
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
