import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));

import { EmptyState } from './EmptyState';
import { SkeletonCards, SkeletonRows } from './Skeleton';

describe('shared visual states', () => {
  it('announces loading once while keeping skeleton geometry decorative', () => {
    const { container } = render(() => <SkeletonRows count={4} />);

    expect(screen.getByRole('status', { name: 'common.loading' })).toBeInTheDocument();
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);
  });

  it('renders the requested number of cover-shaped placeholders', () => {
    const { container } = render(() => <SkeletonCards count={6} compact />);

    expect(screen.getByRole('status', { name: 'common.loading' })).toBeInTheDocument();
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(6);
  });

  it('gives empty copy a semantic status surface', () => {
    render(() => <EmptyState tone="danger">Could not reach the library.</EmptyState>);

    expect(screen.getByRole('status')).toHaveTextContent('Could not reach the library.');
  });
});
