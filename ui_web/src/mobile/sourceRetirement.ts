import type { ProgramTransport } from '../lib/program/runtime';

/** Retire an acquired source globally, without changing any surviving occurrence identity. */
export async function retireNativeSource(transport: ProgramTransport, id: string, generation: number,
  current: () => boolean): Promise<void> {
  if (!current()) return;
  const state = await transport.command({ action: 'retireSource', id, generation });
  if (!current()) return;
  if (state.generation !== generation || state.items.some(item => item.source === 'local' && item.id === id)) {
    throw new Error('Native source retirement not observed');
  }
  if (!state.items.length && (state.playWhenReady || state.radio?.active || state.autoplay?.active)) {
    throw new Error('Empty program was not closed');
  }
}
