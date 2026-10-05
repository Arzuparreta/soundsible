import { registerPlugin } from '@capacitor/core';

interface ClipboardBridge {
  write(options: { generation: number; text: string; sensitive: boolean }): Promise<{ copied: boolean }>;
}
const clipboard = registerPlugin<ClipboardBridge>('SoundsibleClipboard');

/** Explicit OS copy only; no storage or browser fallback for credentials. */
export function nativeCopy(generation: () => number) {
  return async (text: string, sensitive: boolean): Promise<boolean> => {
    const epoch = generation();
    const result = await clipboard.write({ generation: epoch, text, sensitive });
    return epoch === generation() && result.copied === true;
  };
}
