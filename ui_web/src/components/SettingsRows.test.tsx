import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ActionRow } from './SettingsRows';

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
