import { createEffect, createSignal, createUniqueId, For, on, Show } from 'solid-js';
import { DEFAULT_CUSTOM_COLORS, deriveCustomColors, normalizeHex } from '../boot/customColors.js';
import type { Theme } from '../boot/themes';
import { ColorControl, Control, TextControl } from '../design/Control';
import type { CustomColors } from '../lib/colorPreferences';
import { t, locale, setLocale, LOCALES, type Locale } from '../lib/i18n';
import { CheckIcon, ChevronDownIcon } from './icons';
import { ChoiceGroup, SelectRow, SettingsGroup } from './SettingsRows';
import styles from './AppearanceSettingsView.module.css';

const labels: Record<Theme, () => string> = {
  system: () => t('settings.themeSystem'), dark: () => t('settings.themeDark'),
  light: () => t('settings.themeLight'), custom: () => t('settings.themeCustom'),
};
const order: Theme[] = ['system', 'dark', 'light', 'custom'];

function ColorField(props: { label: string; value: string; reset: number; update: (value: string) => void }) {
  const id = createUniqueId();
  const [draft, setDraft] = createSignal<string>();
  const [invalid, setInvalid] = createSignal(false);
  createEffect(on(() => props.value, (value) => {
    if (normalizeHex(draft()) !== value) {
      setDraft(undefined);
      setInvalid(false);
    }
  }, { defer: true }));

  createEffect(on(() => props.reset, () => {
    setDraft(undefined);
    setInvalid(false);
  }, { defer: true }));
  function commit() {
    if (draft() === undefined) return;
    const color = normalizeHex(draft());
    setInvalid(!color);
    if (color) {
      props.update(color);
      setDraft(undefined);
    }
  }
  function pick(value: string) {
    const color = normalizeHex(value);
    if (!color) return;
    setDraft(undefined);
    setInvalid(false);
    props.update(color);
  }
  return <div class={styles.field}>
    <label class={styles.label} for={id}>{props.label}</label>
    <div class={styles.controls}>
      <ColorControl class={styles.swatch} value={props.value} aria-label={props.label}
        onInput={event => pick(event.currentTarget.value)} onChange={event => pick(event.currentTarget.value)} />
      <TextControl id={id} class={styles.hex} value={draft() ?? props.value} spellcheck={false}
        aria-label={`${props.label} (HEX)`} aria-invalid={invalid() || undefined}
        aria-describedby={invalid() ? `${id}-error` : undefined}
        autocomplete="off" autocapitalize="off"
        onInput={event => {
          const value = event.currentTarget.value;
          setDraft(value);
          setInvalid(false);
          // Keep the literal draft and caret while the user types. A complete
          // value previews immediately, including when pasted.
          const color = normalizeHex(value);
          if (color && value.trim().replace(/^#/, '').length === 6) props.update(color);
        }}
        onBlur={commit} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); }
          if (event.key === 'Escape') { setDraft(undefined); setInvalid(false); }
        }} />
    </div>
    <Show when={invalid()}><span class={styles.error} id={`${id}-error`} role="alert">{t('settings.colorInvalid')}</span></Show>
  </div>;
}

const palettes = [
  { label: 'settings.paletteTide', colors: DEFAULT_CUSTOM_COLORS },
  { label: 'settings.paletteEmber', colors: { canvas: '#322026', accent: '#ffb289' } },
  { label: 'settings.paletteClay', colors: { canvas: '#f6e9d8', accent: '#934627' } },
  { label: 'settings.paletteSage', colors: { canvas: '#e2ece1', accent: '#32604b' } },
] as const;

function CustomColorEditor(props: { colors: CustomColors; apply: (colors: CustomColors) => void }) {
  const matches = (colors: CustomColors) => props.colors.canvas === colors.canvas && props.colors.accent === colors.accent;
  const [expanded, setExpanded] = createSignal(!palettes.some(palette => matches(palette.colors)));
  const [reset, setReset] = createSignal(0);
  const fieldsId = createUniqueId();
  function choose(colors: CustomColors) {
    props.apply(colors);
    setReset(value => value + 1);
  }
  function update(key: keyof CustomColors, value: string) {
    if (value !== props.colors[key]) props.apply({ ...props.colors, [key]: value });
  }
  return <SettingsGroup label={t('settings.colorPalettes')}>
    <div class={styles.editor}>
      <div class={styles.palettes}>
        <For each={palettes}>{palette => {
          const { tokens } = deriveCustomColors(palette.colors);
          return <Control class={styles.palette} aria-pressed={matches(palette.colors)} onClick={() => choose(palette.colors)}>
            <span class={styles.sample} aria-hidden="true" style={{ '--sample-base': tokens['bg-base'], '--sample-accent': tokens.accent }} />
            <span class={styles.caption}>{t(palette.label)}
              <Show when={matches(palette.colors)}><CheckIcon /></Show>
            </span>
          </Control>;
        }}</For>
      </div>
      <div class={styles.tools}>
        <Control class={styles.disclosure} aria-expanded={expanded()} aria-controls={fieldsId}
          onClick={() => setExpanded(value => !value)}>
          {t('settings.chooseColors')}<ChevronDownIcon />
        </Control>
        <Show when={expanded()}>
          <Control class={styles.reset} onClick={() => choose(DEFAULT_CUSTOM_COLORS)}>{t('settings.resetColors')}</Control>
        </Show>
      </div>
      <div id={fieldsId} hidden={!expanded()}>
        <div class={styles.fields}>
          <ColorField label={t('settings.canvasColor')} value={props.colors.canvas} reset={reset()} update={value => update('canvas', value)} />
          <ColorField label={t('settings.accentColor')} value={props.colors.accent} reset={reset()} update={value => update('accent', value)} />
        </div>
      </div>
    </div>
  </SettingsGroup>;
}

/** Shared by the browser player, desktop WebView and offline Android client. */
export function AppearanceSettingsView(props: {
  theme: Theme;
  colors: CustomColors;
  onTheme: (theme: Theme, colors?: CustomColors) => void;
}) {
  return <>
    <ChoiceGroup anchor="theme" label={t('settings.theme')} value={props.theme} onChange={props.onTheme}
      options={order.map(theme => ({ value: theme, label: labels[theme](), hint: theme === 'system' ? t('settings.note.theme') : undefined }))} />
    <Show when={props.theme === 'custom'}>
      <CustomColorEditor colors={props.colors} apply={colors => props.onTheme('custom', colors)} />
    </Show>
    <SettingsGroup><SelectRow anchor="language" label={t('settings.language')} value={locale()} onChange={value => void setLocale(value as Locale)}>
      <For each={LOCALES}>{language => <option value={language.code}>{language.native}</option>}</For>
    </SelectRow></SettingsGroup>
  </>;
}
