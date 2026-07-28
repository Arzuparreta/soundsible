import { describe, expect, it } from 'vitest';
import {
  createScanGeneration,
  errorText,
  folderPathFromDialogResult,
  formatBytes,
} from './onboarding.js';

describe('folder dialog result', () => {
  it('accepts one path and treats cancellation as empty', () => {
    expect(folderPathFromDialogResult('C:\\Música')).toBe('C:\\Música');
    expect(folderPathFromDialogResult(['D:\\Library'])).toBe('D:\\Library');
    expect(folderPathFromDialogResult(null)).toBeNull();
    expect(folderPathFromDialogResult('  ')).toBeNull();
  });
});

describe('scan generations', () => {
  it('rejects stale async scan results', () => {
    const scans = createScanGeneration();
    const first = scans.next();
    const second = scans.next();
    expect(scans.isCurrent(first)).toBe(false);
    expect(scans.isCurrent(second)).toBe(true);
    scans.cancel();
    expect(scans.isCurrent(second)).toBe(false);
  });
});

describe('formatting helpers', () => {
  it('formats binary sizes and native errors deterministically', () => {
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(errorText(new Error('picker failed'))).toBe('picker failed');
    expect(errorText('scan failed')).toBe('scan failed');
  });
});
