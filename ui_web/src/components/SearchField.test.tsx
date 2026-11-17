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

it('puts a leading control in place of the magnifier, built once', () => {
  let built = 0;
  const Leading = () => { built += 1; return <button type="button">Back</button>; };
  const { container } = render(() => <SearchField value="" onInput={() => {}} placeholder="Search" leading={<Leading />} />);
  expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  expect(container.querySelector('svg')).toBeNull();
  expect(built).toBe(1);
});
