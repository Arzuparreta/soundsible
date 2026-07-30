/**
 * Copying text without assuming a secure context.
 *
 * Soundsible is normally reached over plain HTTP on a LAN or Tailscale address,
 * and browsers expose `navigator.clipboard` (and `navigator.share`) only on
 * HTTPS or localhost. Reaching for the async API unguarded is what made every
 * share fail with "could not share": the property is simply not there, so the
 * call threw before it could copy anything.
 *
 * So: use the async API where it exists, and fall back to the legacy
 * `execCommand('copy')` path, which still works in insecure contexts as long as
 * it runs inside a user gesture. Returns whether the text made it across —
 * callers decide what to say, and none of them get an exception.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied, or called without user activation. The legacy path may still work.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body || !document.execCommand) return false;
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.setAttribute('aria-hidden', 'true');
  // Off-screen, but still selectable: `display:none` / `visibility:hidden`
  // elements cannot be selected, and a visible one would scroll the page.
  helper.style.position = 'fixed';
  helper.style.top = '0';
  helper.style.left = '0';
  helper.style.width = '1px';
  helper.style.height = '1px';
  helper.style.padding = '0';
  helper.style.border = 'none';
  helper.style.opacity = '0';
  const previous = document.activeElement as HTMLElement | null;
  document.body.appendChild(helper);
  try {
    helper.focus();
    helper.select();
    // iOS Safari ignores select() on a readonly textarea.
    helper.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    helper.remove();
    previous?.focus?.();
  }
}
