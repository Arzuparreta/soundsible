import { fireEvent, render, screen, cleanup } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { AppearanceSettingsView } from './AppearanceSettingsView';
import { DisplayPreferencesView } from './DisplayPreferencesView';
import type { Theme } from '../boot/themes';
import type { InterfaceSize } from '../lib/visualPreferences';
afterEach(cleanup);
it('shares reactive theme and display controls without importing the audio store', async () => {
  const changed = vi.fn();
  render(() => {
    const [theme, setTheme] = createSignal<Theme>('system');
    const [size, setSize] = createSignal<InterfaceSize>('normal');
    const [contrast, setContrast] = createSignal(false);
    return <><AppearanceSettingsView theme={theme()} onTheme={value => { changed(value); setTheme(value); }} />
      <DisplayPreferencesView interfaceSize={size()} highContrast={contrast()} onSize={setSize} onContrast={setContrast} /></>;
  });
  const slate = screen.getByRole('radio', { name: 'Slate' });
  await fireEvent.click(slate); expect(changed).toHaveBeenCalledWith('slate'); expect(slate).toBeChecked();
  expect(screen.getByRole('combobox', { name: 'Language' }).querySelectorAll('option')).toHaveLength(4);
  await fireEvent.click(screen.getByRole('button', { name: 'Large' }));
  expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Large');
  const highContrast = screen.getByRole('checkbox', { name: 'Enhanced contrast' });
  await fireEvent.click(highContrast); expect(highContrast).toBeChecked();
});
