import { createSignal } from 'solid-js';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ActionRow, ChoiceGroup, SwitchRow } from './SettingsRows';

const touch = (clientY: number) => ({
  pointerId: 1,
  pointerType: 'touch',
  isPrimary: true,
  clientX: 20,
  clientY,
});

describe('settings touch rows', () => {
  it('cancels the action when the touch becomes a scroll', () => {
    const onClick = vi.fn();
    render(() => <ActionRow label="Reload library" onClick={onClick} />);
    const row = screen.getByRole('button', { name: 'Reload library' });

    fireEvent.pointerDown(row, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 20,
      clientY: 30,
    });
    fireEvent.pointerMove(row, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 20,
      clientY: 50,
    });
    fireEvent.pointerUp(row, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 20,
      clientY: 50,
    });

    expect(row).toHaveAttribute('data-pressable');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('runs a stationary touch exactly once', () => {
    const onClick = vi.fn();
    render(() => <ActionRow label="Reload library" onClick={onClick} />);
    const row = screen.getByRole('button', { name: 'Reload library' });

    fireEvent.pointerDown(row, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 20,
      clientY: 30,
    });
    fireEvent.pointerUp(row, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 20,
      clientY: 30,
    });
    fireEvent.click(row, { detail: 1 });

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('settings switch rows', () => {
  it('is one switch named by its label and described by its explanation', () => {
    render(() => (
      <SwitchRow label="Mezclar entre canciones" hint="Sin fundidos" checked={true} onChange={() => {}} />
    ));
    const row = screen.getByRole('switch', { name: 'Mezclar entre canciones' });

    expect(row).toHaveAttribute('aria-checked', 'true');
    expect(row).toHaveAccessibleDescription('Sin fundidos');
    // The explanation is part of the target, not text beside it.
    expect(row).toContainElement(screen.getByText('Sin fundidos'));
  });

  it('flips from a tap on its words, but not from a scroll that starts there', () => {
    const [checked, setChecked] = createSignal(false);
    render(() => (
      <SwitchRow label="Igualar el volumen" hint="Mismo volumen" checked={checked()} onChange={() => setChecked(!checked())} />
    ));
    const words = screen.getByText('Mismo volumen');

    fireEvent.pointerDown(words, touch(30));
    fireEvent.pointerMove(words, touch(60));
    fireEvent.pointerUp(words, touch(60));
    expect(checked()).toBe(false);

    fireEvent.pointerDown(words, touch(30));
    fireEvent.pointerUp(words, touch(30));
    expect(checked()).toBe(true);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('settings choice groups', () => {
  it('offers every option as a radio named by its label alone', () => {
    const onChange = vi.fn();
    render(() => (
      <ChoiceGroup
        label="Tema"
        options={[
          { value: 'system', label: 'Sistema', hint: 'Sigue a tu dispositivo' },
          { value: 'dark', label: 'Oscuro' },
        ]}
        value="system"
        onChange={onChange}
      />
    ));

    expect(screen.getByRole('radiogroup', { name: 'Tema' })).toBeInTheDocument();
    const system = screen.getByRole('radio', { name: 'Sistema' });
    expect(system).toBeChecked();
    expect(system).toHaveAccessibleDescription('Sigue a tu dispositivo');

    fireEvent.click(screen.getByRole('radio', { name: 'Oscuro' }));
    expect(onChange).toHaveBeenCalledWith('dark');
  });
});
