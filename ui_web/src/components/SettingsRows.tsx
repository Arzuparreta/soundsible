import { For, Show, type JSX } from 'solid-js';
import { A } from '@solidjs/router';
import styles from './SettingsRows.module.css';

/**
 * The vocabulary every settings screen is built from: a titled group of rows
 * with an optional explanatory footer, and the handful of row shapes that go
 * inside it. Keeping them here is what lets a section read as data rather than
 * as markup, and what keeps every submenu visually identical.
 */

export function Chevron(props: { class?: string }) {
  return (
    <svg
      class={`${styles.chevron} ${props.class ?? ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg class={styles.warnIcon} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 3.2L2.4 20.2a1 1 0 0 0 .88 1.5h17.44a1 1 0 0 0 .88-1.5L12 3.2zm0 5.3a.9.9 0 0 1 .9.9v4.4a.9.9 0 0 1-1.8 0V9.4a.9.9 0 0 1 .9-.9zm0 8.4a1.05 1.05 0 1 1 0-2.1 1.05 1.05 0 0 1 0 2.1z"
      />
    </svg>
  );
}

/** A group of rows. `note` is the quiet footer that explains what the group does. */
export function SettingsGroup(props: {
  label?: string;
  note?: string;
  plain?: boolean;
  children: JSX.Element;
}) {
  return (
    <section class={styles.group}>
      <Show when={props.label}>
        <h2 class={styles.groupLabel}>{props.label}</h2>
      </Show>
      <div class={styles.panel} classList={{ [styles.panelPlain]: props.plain }}>
        {props.children}
      </div>
      <Show when={props.note}>
        <p class={styles.groupNote}>{props.note}</p>
      </Show>
    </section>
  );
}

function RowText(props: { label: string; hint?: string; warn?: boolean }) {
  return (
    <span class={styles.text}>
      <span class={styles.label}>
        {props.label}
        <Show when={props.warn}>
          <WarnIcon />
        </Show>
      </span>
      <Show when={props.hint}>
        <span class={styles.hint}>{props.hint}</span>
      </Show>
    </span>
  );
}

/** Label on the left, whatever control (or value) you pass on the right. */
export function SettingRow(props: { label: string; hint?: string; children?: JSX.Element }) {
  return (
    <div class={styles.row}>
      <RowText label={props.label} hint={props.hint} />
      <Show when={props.children}>
        <span class={styles.control}>{props.children}</span>
      </Show>
    </div>
  );
}

/** Read-only fact: label left, value right. */
export function ValueRow(props: { label: string; value: JSX.Element }) {
  return (
    <div class={styles.row}>
      <RowText label={props.label} />
      <span class={styles.value}>{props.value}</span>
    </div>
  );
}

export function SwitchRow(props: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div class={styles.row}>
      <RowText label={props.label} hint={props.hint} />
      <button
        type="button"
        class={styles.switch}
        classList={{ [styles.switchOn]: props.checked }}
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        onClick={props.onChange}
      >
        <span class={styles.knob} />
      </button>
    </div>
  );
}

/** Row that does something. Chevron on the right so it reads as "goes somewhere". */
export function ActionRow(props: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  warn?: boolean;
}) {
  return (
    <button
      type="button"
      class={styles.rowBtn}
      classList={{ [styles.rowBtnDanger]: props.danger }}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <RowText label={props.label} hint={props.hint} warn={props.warn} />
      <Chevron />
    </button>
  );
}

/** Row that navigates elsewhere in the app. */
export function NavRow(props: { href: string; label: string; hint?: string }) {
  return (
    <A href={props.href} class={styles.rowLink}>
      <RowText label={props.label} hint={props.hint} />
      <Chevron />
    </A>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label?: string;
  icon?: JSX.Element;
  aria?: string;
}

/**
 * Label above, full-width segmented control below. Stacking beats squeezing a
 * three-way choice into the right edge of a row — it stays tappable at every
 * interface size and never wraps into a broken column.
 */
export function SegmentedRow<T extends string>(props: {
  label: string;
  hint?: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div class={styles.stackRow}>
      <RowText label={props.label} hint={props.hint} />
      <div class={styles.segment} role="group" aria-label={props.label}>
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
              class={styles.seg}
              classList={{ [styles.segOn]: props.value === option.value }}
              aria-label={option.aria}
              aria-pressed={props.value === option.value}
              onClick={() => props.onChange(option.value)}
            >
              <Show when={option.icon} fallback={option.label}>
                <span class={styles.segIcon}>{option.icon}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

/** Native select on the right of a row — used where the option list is long. */
export function SelectRow(props: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  children: JSX.Element;
}) {
  return (
    <div class={styles.row}>
      <RowText label={props.label} hint={props.hint} />
      <select
        class={styles.select}
        value={props.value}
        aria-label={props.label}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        {props.children}
      </select>
    </div>
  );
}

/** Free-text row. The field sits under the label so long values stay readable. */
export function InputRow(props: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  onInput: (value: string) => void;
}) {
  return (
    <div class={styles.stackRow}>
      <RowText label={props.label} hint={props.hint} />
      <input
        class={styles.input}
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.label}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </div>
  );
}

export { styles as settingsRowStyles };
