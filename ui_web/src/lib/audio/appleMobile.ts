/** Identify mobile Apple browsers, including iPadOS with its desktop user agent. */
export function isAppleMobile(browser: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  return /iPhone|iPad|iPod/.test(browser.userAgent) || (browser.platform === 'MacIntel' && browser.maxTouchPoints > 1);
}
