import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { setLocale, t } from '../lib/i18n';
import { Placeholder } from './Placeholder';

vi.mock('@solidjs/router', () => ({
  A: (props: { href: string; class?: string; children: unknown }) => <a href={props.href} class={props.class}>{props.children as string}</a>,
}));
vi.mock('../lib/appBar', () => ({ useAppBar: vi.fn() }));

describe('Unknown address', () => {
  it('names the problem and leads back to the library and Discover, with no demo', () => {
    setLocale('en');
    render(() => <Placeholder title={t('placeholder.notFoundTitle')} blurb={t('placeholder.notFoundBlurb')} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('href', '/library');
    expect(screen.getByRole('link', { name: 'Discover' })).toHaveAttribute('href', '/search');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/overlay/i)).toBeNull();
  });
});
