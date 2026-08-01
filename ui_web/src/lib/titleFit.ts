/**
 * Stable title tiers retained for consumers/tests while the shared Stage now
 * handles overflow with layout constraints instead of Auto-only title markup.
 */
export function titleFit(title: string): 'lg' | 'md' | 'sm' | 'xs' {
  const length = title.trim().length;
  if (length <= 20) return 'lg';
  if (length <= 36) return 'md';
  if (length <= 58) return 'sm';
  return 'xs';
}
