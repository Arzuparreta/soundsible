import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  openContextMenu: vi.fn(),
}));

vi.mock('../lib/contextMenu', () => ({ openContextMenu: harness.openContextMenu }));

import { PlayerLayoutControl } from './PlayerLayoutControl';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PlayerLayoutControl', () => {
  it('opens the layout supplied by either player mode without presenting itself as a toggle', () => {
    const onSelect = vi.fn();
    const onReset = vi.fn();
    render(() => (
      <PlayerLayoutControl
        title="Workspace layout"
        ariaLabel="Change layout"
        resetLabel="Reset layout"
        presets={[
          { id: 'balanced', label: 'Balanced' },
          { id: 'stage', label: 'Player focus' },
          { id: 'left', label: 'Left focus' },
          { id: 'right', label: 'Right focus' },
        ]}
        onSelect={onSelect}
        onReset={onReset}
      />
    ));

    const control = screen.getByRole('button', { name: 'Change layout' });
    expect(control).toHaveAttribute('aria-haspopup', 'menu');
    expect(control).not.toHaveAttribute('aria-pressed');
    fireEvent.click(control);

    expect(harness.openContextMenu).toHaveBeenCalledOnce();
    const options = harness.openContextMenu.mock.calls[0][0];
    expect(options.title).toBe('Workspace layout');
    expect(options.actions.map((action: { label: string }) => action.label)).toEqual([
      'Balanced',
      'Player focus',
      'Left focus',
      'Right focus',
      'Reset layout',
    ]);

    options.actions[2].onSelect();
    options.actions[4].onSelect();
    expect(onSelect).toHaveBeenCalledWith('left');
    expect(onReset).toHaveBeenCalledOnce();
  });
});
