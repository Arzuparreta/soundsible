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
    expect(screen.getByLabelText('Posición 2')).toHaveValue('/search');
    fireEvent.change(screen.getByLabelText('Posición 1'), { target: { value: '/settings' } });
    expect(bottomNavigation()).toEqual(['/settings', '/search', '/favourites', '/']);
    expect(screen.getByLabelText('Posición 4')).toHaveValue('/');
    expect(screen.getByLabelText('Posición 1')).toHaveValue('/settings');
    fireEvent.click(screen.getByRole('button', { name: 'Añadir destino' }));
    expect(screen.getAllByRole('combobox')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Añadir destino' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Quitar Ajustes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quitar Biblioteca' }));
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Quitar Buscar' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Restablecer predeterminados' }));
    expect(bottomNavigation()).toEqual(defaultBottomNavigation);
  });
});
