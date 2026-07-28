import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setInterfaceSize: vi.fn(),
  setHighContrast: vi.fn(),
}));

vi.mock('../stores', () => ({
  state: { interfaceSize: 'normal', highContrast: false },
  actions: {
    setInterfaceSize: mocks.setInterfaceSize,
    setHighContrast: mocks.setHighContrast,
  },
}));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));

import { DisplayPreferences } from './DisplayPreferences';

describe('display accessibility control', () => {
  it('exposes the three finite interface sizes as an accessible range and anchors', () => {
    render(() => <DisplayPreferences />);

    const range = screen.getByRole('slider', { name: 'accessibility.interfaceSize' });
    expect(range).toHaveAttribute('min', '0');
    expect(range).toHaveAttribute('max', '2');
    expect(range).toHaveAttribute('aria-valuetext', 'accessibility.size.normal');

    fireEvent.click(screen.getByRole('button', { name: 'accessibility.size.large' }));
    expect(mocks.setInterfaceSize).toHaveBeenCalledWith('large');
  });

  it('keeps enhanced contrast independent from interface size', () => {
    render(() => <DisplayPreferences />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(mocks.setHighContrast).toHaveBeenCalledWith(true);
  });
});
