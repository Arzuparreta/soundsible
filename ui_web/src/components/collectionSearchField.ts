import type { Accessor } from 'solid-js';
import { t } from '../lib/i18n';
import type { SearchFieldProps } from './SearchField';

export function collectionSearchField(value: Accessor<string>, onInput: (value: string) => void, placeholder?: string): SearchFieldProps {
  return {
    get value() { return value(); },
    placeholder: placeholder ?? t('library.filterCollection'),
    onInput,
    onKeyDown: event => {
      if (event.key !== 'Escape' || event.isComposing || !value()) return;
      event.preventDefault();
      event.stopPropagation();
      onInput('');
    },
  };
}
