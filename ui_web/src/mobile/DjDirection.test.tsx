import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { openNativeDjDirection } from './DjDirection';
import { discardOverlays, OverlayOutlet } from '../lib/overlay';
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
afterEach(() => { discardOverlays(); cleanup(); });

it('retains exclusions and leaves a failed direction edit available for retry', async () => {
  const submit = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(undefined);
  render(() => <OverlayOutlet />);
  openNativeDjDirection({ energy: 0, familiarity: 0, prompt: '', include: ['artist'], exclude: ['genre'] }, () => true, submit);
  await fireEvent.input(screen.getByLabelText('autoMode.booth.energy'), { target: { value: '1' } });
  await fireEvent.input(screen.getByLabelText('autoMode.dj.tellDj'), { target: { value: ' más suave ' } });
  await fireEvent.submit(screen.getByRole('button', { name: 'autoMode.dj.send' }).closest('form')!);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(submit).toHaveBeenCalledWith({ energy: 0.65, familiarity: 0, prompt: 'más suave', include: ['artist'], exclude: ['genre'] });
  await fireEvent.submit(screen.getByRole('button', { name: 'autoMode.dj.send' }).closest('form')!);
  expect(submit).toHaveBeenCalledTimes(2);
});

it('disposes an editor when its programme changes and never submits to the new owner', async () => {
  const [current, setCurrent] = createSignal(true);
  const submit = vi.fn(async () => {});
  render(() => <OverlayOutlet />);
  openNativeDjDirection(undefined, current, submit);
  const form = screen.getByRole('button', { name: 'autoMode.dj.send' }).closest('form')!;
  setCurrent(false);
  await fireEvent.submit(form);
  expect(submit).not.toHaveBeenCalled();
});
