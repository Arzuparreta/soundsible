import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { expect, it, vi } from 'vitest';
import { SearchField } from './SearchField';

it('returns focus to the search input when its clear button disappears', () => {
  const [value, setValue] = createSignal('josh');
  const inputRef = vi.fn();
  render(() => <SearchField value={value()} onInput={setValue} placeholder="Search music" clearLabel="Clear search" inputRef={inputRef} />);
  const input = screen.getByRole('searchbox');
  const clear = screen.getByRole('button', { name: 'Clear search' });
  expect(inputRef).toHaveBeenCalledWith(input);
  clear.focus();
  fireEvent.click(clear);
  expect(input).toHaveValue('');
  expect(input).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
});
