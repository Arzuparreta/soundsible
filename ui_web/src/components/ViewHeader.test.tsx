import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewHeader } from './ViewHeader';

afterEach(() => {
  document.querySelectorAll('[data-primary-scroll]').forEach((node) => node.remove());
});

describe('ViewHeader title', () => {
  it('renders as plain text when no tap handler is given', () => {
    render(() => <ViewHeader title="Your library" />);

    expect(screen.queryByRole('button', { name: 'Your library' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Your library' })).toBeInTheDocument();
  });

  it('tapping the title invokes onTitleTap', () => {
    const onTitleTap = vi.fn();
    render(() => <ViewHeader title="Your library" onTitleTap={onTitleTap} />);

    fireEvent.click(screen.getByRole('button', { name: 'Your library' }));

    expect(onTitleTap).toHaveBeenCalledOnce();
  });
});
