import { beforeEach, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
const native = vi.hoisted(() => ({ addListener: vi.fn(), minimizeApp: vi.fn() }));
const surfaces = vi.hoisted(() => ({ menu: vi.fn(), overlay: vi.fn() }));
vi.mock('@capacitor/app', () => ({ App: native }));
vi.mock('../lib/contextMenu', () => ({ dismissContextMenu: surfaces.menu }));
vi.mock('../lib/overlay', () => ({ dismissTopOverlay: surfaces.overlay }));
import { attachNativeBack, handleNativeBack } from './back';
import { registerNativeBack } from './backNavigation';
beforeEach(() => { vi.clearAllMocks(); surfaces.menu.mockReturnValue(false); surfaces.overlay.mockReturnValue(false); native.minimizeApp.mockResolvedValue(undefined); });
it('keeps overlays above nested routes and removes routes with their Solid owner', () => {
  let dispose!: () => void;
  const parent = vi.fn(() => true), detail = vi.fn(() => true);
  createRoot(done => { dispose = done; registerNativeBack(parent); registerNativeBack(detail); });
  surfaces.overlay.mockReturnValue(true); expect(handleNativeBack()).toBe(true); expect(detail).not.toHaveBeenCalled();
  surfaces.overlay.mockReturnValue(false); expect(handleNativeBack()).toBe(true); expect(detail).toHaveBeenCalledOnce(); expect(parent).not.toHaveBeenCalled();
  dispose(); expect(handleNativeBack()).toBe(false);
});
it('minimizes only at root and ignores a listener delivered after disposal', async () => {
  let back!: () => void; let resolve!: (value: {remove: () => Promise<void>}) => void;
  native.addListener.mockImplementation((_event, callback) => { back = callback; return new Promise(done => { resolve = done; }); });
  const remove = vi.fn().mockResolvedValue(undefined), failure = vi.fn();
  const stop = attachNativeBack(failure);
  back(); expect(native.minimizeApp).toHaveBeenCalledOnce();
  surfaces.menu.mockReturnValue(true); back(); expect(native.minimizeApp).toHaveBeenCalledOnce();
  stop(); surfaces.menu.mockReturnValue(false); back(); expect(native.minimizeApp).toHaveBeenCalledOnce();
  resolve({ remove }); await Promise.resolve(); await Promise.resolve(); expect(remove).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
});
