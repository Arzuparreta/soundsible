import { createUniqueId, For, Show, type JSX } from 'solid-js';
import { createResponsiveTap } from '../lib/responsiveTap';
import { A, useNavigate } from '@solidjs/router';
import type { SettingAnchor } from '../lib/settingsCatalog';
import styles from './SettingsRows.module.css';

/**
 * The vocabulary every settings screen is built from: a titled group of rows
 * with an optional explanatory footer, and the handful of row shapes that go
 * inside it. Keeping them here is what lets a section read as data rather than
 * as markup, and what keeps every submenu visually identical.
 *
 * A row explains itself: what a setting does sits under its label, so a group
 * of one needs no title and no footer to be understood.
 */

/**
 * Marks the element the settings search lands on. Rows take it as `anchor`;
 * panels that bring their own markup spread this instead. Typed against the
 * catalog, so an anchor no search result points at does not compile.
 */
export function settingAnchor(id: SettingAnchor): { 'data-setting': SettingAnchor } {
  return { 'data-setting': id };
}

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
  anchor?: SettingAnchor;
  children: JSX.Element;
}) {
  return (
    <section class={styles.group} data-setting={props.anchor}>
      <Show when={props.label}>
        <h2 class={styles.groupLabel}>{props.label}</h2>
      </Show>
      <div class={styles.panel}>{props.children}</div>
      <Show when={props.note}>
        <p class={styles.groupNote}>{props.note}</p>
      </Show>
    </section>
  );
}

function RowText(props: {
  label: string;
  hint?: string;
  warn?: boolean;
  labelId?: string;
  hintId?: string;
}) {
  return (
    <span class={styles.text}>
      <span class={styles.label} id={props.labelId}>
        {props.label}
        <Show when={props.warn}>
          <WarnIcon />
        </Show>
      </span>
      <Show when={props.hint}>
        <span class={styles.hint} id={props.hintId}>
          {props.hint}
        </span>
      </Show>
    </span>
  );
}

/** Label on the left, whatever control (or value) you pass on the right. */
export function SettingRow(props: {
  label: string;
  hint?: string;
  anchor?: SettingAnchor;
  children?: JSX.Element;
}) {
  return (
    <div class={styles.row} data-setting={props.anchor}>
      <RowText label={props.label} hint={props.hint} />
      <Show when={props.children}>
        <span class={styles.control}>{props.children}</span>
      </Show>
    </div>
  );
}

/** Read-only fact: label left, value right. */
export function ValueRow(props: {
  label: string;
  hint?: string;
  value: JSX.Element;
  anchor?: SettingAnchor;
}) {
  return (
    <div class={styles.row} data-setting={props.anchor}>
      <RowText label={props.label} hint={props.hint} />
      <span class={styles.value}>{props.value}</span>
    </div>
  );
}

/**
 * An on/off setting. The whole row is the switch, so the label and the words
 * under it are as good a target as the track. The name stays the label alone;
 * the explanation is its description.
 */
export function SwitchRow(props: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  anchor?: SettingAnchor;
}) {
  const hintId = createUniqueId();
  // Same activation as every other row in a scroller: a flick that starts on
  // the row scrolls, it does not flip the setting.
  const tap = createResponsiveTap({ disabled: () => Boolean(props.disabled), onTap: () => props.onChange() });

  return (
    <div class={styles.field} data-setting={props.anchor}>
      <button
        type="button"
        class={styles.rowBtn}
        role="switch"
        disabled={props.disabled}
        aria-checked={props.checked}
        aria-label={props.label}
        aria-describedby={props.hint ? hintId : undefined}
        data-pressable
        {...tap}
      >
        <RowText label={props.label} hint={props.hint} hintId={hintId} />
        <span class={styles.switch} classList={{ [styles.switchOn]: props.checked }} aria-hidden="true">
          <span class={styles.knob} />
        </span>
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
  anchor?: SettingAnchor;
}) {
  const tap = createResponsiveTap({
    disabled: () => Boolean(props.disabled),
    onTap: props.onClick,
  });

  return (
    <button
      type="button"
      class={styles.rowBtn}
      classList={{ [styles.rowBtnDanger]: props.danger }}
      disabled={props.disabled}
      data-pressable
      data-setting={props.anchor}
      {...tap}
    >
      <RowText label={props.label} hint={props.hint} warn={props.warn} />
      <Chevron />
    </button>
  );
}

/** Row that navigates elsewhere in the app. */
export function NavRow(props: { href: string; label: string; hint?: string; anchor?: SettingAnchor }) {
  const navigate = useNavigate();
  const tap = createResponsiveTap({
    onTap: (event) => {
      event.preventDefault();
      navigate(props.href);
    },
  });

  return (
    <A href={props.href} class={styles.rowLink} data-pressable data-setting={props.anchor} {...tap}>
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
  value: T | undefined;
  onChange: (value: T) => void;
  anchor?: SettingAnchor;
}) {
  return (
    <div class={styles.stackRow} data-setting={props.anchor}>
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
              data-pressable
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

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * One choice out of a short list, every option in view: a titled group of
 * rows, each a native radio, the chosen one marked on the right. Native
 * radios bring the arrow keys and the grouping for free; the label and the
 * explanation are wired apart so a screen reader names the option by its
 * label alone.
 */
export function ChoiceGroup<T extends string>(props: {
  label: string;
  options: ChoiceOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  note?: string;
  anchor?: SettingAnchor;
}) {
  const id = createUniqueId();

  return (
    <section class={styles.group} data-setting={props.anchor}>
      <h2 class={styles.groupLabel} id={`${id}-title`}>
        {props.label}
      </h2>
      <div class={styles.panel} role="radiogroup" aria-labelledby={`${id}-title`}>
        <For each={props.options}>
          {(option, index) => (
            <label class={styles.choice} data-pressable>
              <input
                type="radio"
                class={styles.choiceInput}
                name={id}
                value={option.value}
                checked={props.value === option.value}
                aria-labelledby={`${id}-${index()}`}
                aria-describedby={option.hint ? `${id}-${index()}-hint` : undefined}
                onChange={() => props.onChange(option.value)}
              />
              <RowText
                label={option.label}
                hint={option.hint}
                labelId={`${id}-${index()}`}
                hintId={`${id}-${index()}-hint`}
              />
              <span class={styles.radio} aria-hidden="true" />
            </label>
          )}
        </For>
      </div>
      <Show when={props.note}>
        <p class={styles.groupNote}>{props.note}</p>
      </Show>
    </section>
  );
}

/** Native select on the right of a row — used where the option list is long. */
export function SelectRow(props: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  anchor?: SettingAnchor;
  children: JSX.Element;
}) {
  return (
    <div class={styles.row} data-setting={props.anchor}>
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
  type?: 'text' | 'password';
  autocomplete?: string;
  anchor?: SettingAnchor;
}) {
  return (
    <div class={styles.stackRow} data-setting={props.anchor}>
      <RowText label={props.label} hint={props.hint} />
      <input
        type={props.type ?? 'text'}
        class={styles.input}
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.label}
        // Opt out unless a row asks for filling. A settings field is almost
        // never an account field, and browsers guess otherwise.
        autocomplete={props.autocomplete ?? 'off'}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </div>
  );
}

export { styles as settingsRowStyles };
