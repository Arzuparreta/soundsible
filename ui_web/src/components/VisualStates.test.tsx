import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));

import { EmptyState } from './EmptyState';
import { SkeletonCards, SkeletonRegion, SkeletonRows, SkeletonToolbar } from './Skeleton';
import { SkeletonSurfaceRows } from '../design/SkeletonSurfaceRows';

describe('shared visual states', () => {
  it('announces loading once while keeping skeleton geometry decorative', () => {
    const { container } = render(() => <SkeletonRows count={4} />);

    expect(screen.getByRole('status', { name: 'common.loading' })).toBeInTheDocument();
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);
  });

  it('supports distinct row variants, indexed tracks and decorative composition', () => {
    const { container } = render(() => (
      <SkeletonRegion>
        <SkeletonToolbar meta actions />
        <SkeletonRows count={3} variant="song" indexed round decorative />
        <SkeletonSurfaceRows count={2} variant="setting" decorative />
        <SkeletonSurfaceRows count={2} variant="user" decorative />
        <SkeletonSurfaceRows count={2} variant="device" decorative />
        <SkeletonSurfaceRows count={2} variant="episode" decorative />
        <SkeletonSurfaceRows count={2} variant="download" decorative />
        <SkeletonRows count={2} variant="media" decorative />
      </SkeletonRegion>
    ));

    expect(screen.getAllByRole('status', { name: 'common.loading' })).toHaveLength(1);
    const rows = container.querySelectorAll('[data-skeleton-row]');
    expect(rows).toHaveLength(15);
    expect(container.querySelectorAll('[data-decorative]')).toHaveLength(7);

    const indexedRow = container.querySelector('[data-variant="song"] [data-skeleton-row]');
    expect(indexedRow?.children).toHaveLength(4);

    const settingRow = container.querySelector('[data-variant="setting"] [data-skeleton-row]');
    expect(settingRow?.querySelector('[data-skeleton-cover]')).toBeNull();
    expect(settingRow?.querySelector('[data-skeleton-menu]')).not.toBeNull();

    expect(container.querySelectorAll('[data-variant="user"] [data-skeleton-cover]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-variant="device"] [data-skeleton-cover]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-variant="episode"] [data-skeleton-cover]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-variant="download"] [data-skeleton-cover]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-variant="media"] [data-skeleton-cover]')).toHaveLength(2);
  });

  it('renders the requested number of cover-shaped placeholders', () => {
    const { container } = render(() => <SkeletonCards count={6} compact />);

    expect(screen.getByRole('status', { name: 'common.loading' })).toBeInTheDocument();
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(6);
  });

  it('renders rail and padded card layouts with configurable line counts and shapes', () => {
    const { container } = render(() => (
      <SkeletonRegion>
        <SkeletonCards count={4} layout="rail" shape="round" lines={1} bleedOnTouch decorative />
        <SkeletonCards count={3} layout="grid" lines={3} padded decorative />
      </SkeletonRegion>
    ));

    expect(screen.getAllByRole('status', { name: 'common.loading' })).toHaveLength(1);
    const rail = container.querySelector('[data-skeleton-cards][data-layout="rail"][data-shape="round"]');
    const grid = container.querySelector('[data-skeleton-cards][data-layout="grid"][data-shape="square"]');
    expect(rail?.children).toHaveLength(4);
    expect(rail?.firstElementChild?.children).toHaveLength(2);
    expect(grid?.children).toHaveLength(3);
    expect(grid?.firstElementChild?.children).toHaveLength(4);
  });

  it('gives empty copy a semantic status surface', () => {
    render(() => <EmptyState tone="danger">Could not reach the library.</EmptyState>);

    expect(screen.getByRole('status')).toHaveTextContent('Could not reach the library.');
  });
});
