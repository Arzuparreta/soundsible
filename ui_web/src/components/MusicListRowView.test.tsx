import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { MusicListRowView } from './MusicListRowView';
afterEach(cleanup);
it('read-only native rows carry real metadata and cannot invoke playback', () => {
  const play = vi.fn();
  const { container } = render(() => <MusicListRowView title="Private song" subtitle="Performer" seed="private" disabled onActivate={play} />);
  const button = screen.getByRole('button', { name: 'Private song — Performer' });
  expect(button).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(button); expect(play).not.toHaveBeenCalled();
  expect(container.querySelector('[data-row-menu]')).toBeNull();
  expect(container.querySelector('audio')).toBeNull();
});
