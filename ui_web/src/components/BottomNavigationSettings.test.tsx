import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../lib/i18n';
import { bottomNavigation, setBottomNavigation } from '../lib/bottomNavigation';
import { defaultBottomNavigation } from './primaryNavigation';
import { BottomNavigationSettings } from './BottomNavigationSettings';
beforeEach(async () => { await setLocale('es'); setBottomNavigation(defaultBottomNavigation); });
describe('bottom navigation editor', () => {
  it('swaps occupied destinations, adds up to five and removes down to three', () => {
    render(() => <BottomNavigationSettings />);
    expect(screen.getByLabelText('Posición 2')).toHaveValue('/favourites');
    fireEvent.change(screen.getByLabelText('Posición 1'), { target: { value: '/settings' } });
    expect(bottomNavigation()).toEqual(['/settings', '/favourites', '/search', '/']);
    expect(screen.getByLabelText('Posición 4')).toHaveValue('/');
    expect(screen.getByLabelText('Posición 1')).toHaveValue('/settings');
    fireEvent.click(screen.getByRole('button', { name: 'Añadir destino' }));
    expect(screen.getAllByRole('combobox')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Añadir destino' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Quitar Ajustes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quitar Biblioteca' }));
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Quitar Descubrir' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Restablecer predeterminados' }));
    expect(bottomNavigation()).toEqual(defaultBottomNavigation);
  });
});

it('offers every library subentry as a direct bottom-bar destination', () => {
  render(() => <BottomNavigationSettings />);
  const select = screen.getByLabelText('Posición 1');
  for (const href of ['/library?view=songs', '/library?view=albums', '/library?view=artists', '/?saved=albums', '/?saved=artists']) {
    fireEvent.change(select, { target: { value: href } });
    expect(bottomNavigation()[0]).toBe(href);
    expect(JSON.parse(localStorage.getItem('navigation:bottom')!)[0]).toBe(href);
  }
});
