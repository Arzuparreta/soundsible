import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyText } from './clipboard';

function insecureContext(): void {
  const nav = navigator as unknown as Record<string, unknown>;
  delete nav.clipboard;
}

function withClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

function withExecCommand(result: boolean): ReturnType<typeof vi.fn> {
  const exec = vi.fn(() => result);
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
  return exec;
}

describe('copyText', () => {
  beforeEach(() => insecureContext());
  afterEach(() => {
    insecureContext();
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('uses the async clipboard when the context allows it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard(writeText);
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  // No secure context: the property is simply absent, which is what used to
  // throw at the call site rather than fall back.
  it('copies with execCommand when navigator.clipboard is absent', async () => {
    const exec = withExecCommand(true);
    expect(await copyText('hello')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when the clipboard API rejects', async () => {
    withClipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')));
    const exec = withExecCommand(true);
    expect(await copyText('hello')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('reports failure instead of throwing when nothing is allowed', async () => {
    withClipboard(vi.fn().mockRejectedValue(new Error('nope')));
    withExecCommand(false);
    expect(await copyText('hello')).toBe(false);
  });

  it('reports failure when no copy mechanism exists at all', async () => {
    expect(await copyText('hello')).toBe(false);
  });

  it('cleans up its helper element on every path', async () => {
    withExecCommand(false);
    await copyText('hello');
    withExecCommand(true);
    await copyText('hello');
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('does not copy empty text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard(writeText);
    expect(await copyText('')).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
