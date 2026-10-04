import { getOwner, onCleanup } from 'solid-js';

type BackHandler = () => boolean;
const handlers: { handle: BackHandler }[] = [];
/** Nested views register after their parents; disposal removes their navigation. */
export function registerNativeBack(handler: BackHandler): () => void {
  const entry = { handle: handler };
  handlers.push(entry);
  const dispose = () => { const index = handlers.indexOf(entry); if (index >= 0) handlers.splice(index, 1); };
  if (getOwner()) onCleanup(dispose);
  return dispose;
}
export function dispatchNavigationBack(): boolean {
  for (const entry of [...handlers].reverse()) if (handlers.includes(entry) && entry.handle()) return true;
  return false;
}
