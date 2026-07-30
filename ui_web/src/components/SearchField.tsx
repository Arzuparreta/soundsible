import { Show, type JSX } from 'solid-js';
import { t } from '../lib/i18n';
import styles from './SearchField.module.css';

export interface SearchFieldProps {
  value: string;
  placeholder: string;
  ariaLabel?: string;
  clearLabel?: string;
  global?: boolean;
  inputRef?: (element: HTMLInputElement) => void;
  onInput: (value: string) => void;
  onFocus?: JSX.EventHandler<HTMLInputElement, FocusEvent>;
  onBlur?: JSX.EventHandler<HTMLInputElement, FocusEvent>;
  onKeyDown?: JSX.EventHandler<HTMLInputElement, KeyboardEvent>;
}

/** One responsive search control for full-page search surfaces. */
export function SearchField(props: SearchFieldProps) {
  return (
    <div class={styles.field}>
      <svg class={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </svg>
      <input
        class={styles.input}
        data-global-search-input={props.global ? '' : undefined}
        type="search"
        placeholder={props.placeholder}
        aria-label={props.ariaLabel ?? props.placeholder}
        value={props.value}
        ref={props.inputRef}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onFocus={props.onFocus}
        onBlur={props.onBlur}
        onKeyDown={props.onKeyDown}
      />
      <Show when={props.value}>
        <button
          class={styles.clear}
          type="button"
          aria-label={props.clearLabel ?? t('library.clearSearch')}
          onClick={() => props.onInput('')}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 7 10 10M17 7 7 17" />
          </svg>
        </button>
      </Show>
    </div>
  );
}
