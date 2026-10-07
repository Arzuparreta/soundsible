import { afterEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => bridge }));
import { nativeCopy } from './clipboard';
afterEach(() => vi.resetAllMocks());
it('passes the active native generation and sensitive flag without accepting stale completion', async () => {
  let generation = 7, complete!: (value: { copied: boolean }) => void;
  bridge.write.mockReturnValue(new Promise(done => complete = done));
  const operation = nativeCopy(() => generation)('synthetic-test-secret', true);
  expect(bridge.write).toHaveBeenCalledWith({ generation: 7, text: 'synthetic-test-secret', sensitive: true });
  generation = 8; complete({ copied: true }); expect(await operation).toBe(false);
});
it('reports native refusal and propagates failure to the scoped controller without a fallback', async () => {
  bridge.write.mockResolvedValueOnce({ copied: false }).mockRejectedValueOnce(new Error('denied'));
  const copy = nativeCopy(() => 7);
  expect(await copy('https://engine.example', false)).toBe(false);
  await expect(copy('synthetic-test-secret', true)).rejects.toThrow('denied');
});
