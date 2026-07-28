export function folderPathFromDialogResult(result) {
  if (typeof result === 'string' && result.trim()) return result;
  if (Array.isArray(result) && typeof result[0] === 'string' && result[0].trim()) {
    return result[0];
  }
  return null;
}

export function formatBytes(bytes, locale = undefined) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 1;
  return `${amount.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${units[unit]}`;
}

export function createScanGeneration() {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(value) {
      return value === current;
    },
    cancel() {
      current += 1;
    },
  };
}

export function errorText(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  return String(error ?? 'Unknown error');
}
