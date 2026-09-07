import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimHoldGesture, clearTextSelection, holdGestureConstants } from './holdGesture';

const { ATTRIBUTE, RELEASE_TAIL_MS, MAX_HOLD_MS } = holdGestureConstants;

const armed = () => document.documentElement.hasAttribute(ATTRIBUTE);

/** Select the contents of a fresh paragraph, the way a platform gesture would. */
function selectSomeText(): HTMLElement {
  const host = document.createElement('p');
  host.textContent = 'Una canción con título';
  document.body.append(host);
  const range = document.createRange();
  range.selectNodeContents(host);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return host;
}

function selectStart(): Event {
  const event = new Event('selectstart', { bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

afterEach(() => {
  // Whatever a case left claimed expires on its own failsafe. Flushing it here
  // is what keeps module state from leaking into the next one.
  if (vi.isFakeTimers()) vi.advanceTimersByTime(MAX_HOLD_MS);
  vi.useRealTimers();
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

describe('hold gesture ownership', () => {
  it('marks the document for the life of the press and lets go after the tail', () => {
    vi.useFakeTimers();
    const release = claimHoldGesture();
    expect(armed()).toBe(true);

    release();
    // The finger is up but WebKit may still be resolving its own gesture.
    expect(armed()).toBe(true);

    vi.advanceTimersByTime(RELEASE_TAIL_MS);
    expect(armed()).toBe(false);
  });

  it('holds until the last of several claims lets go', () => {
    vi.useFakeTimers();
    const first = claimHoldGesture();
    const second = claimHoldGesture();

    first();
    vi.advanceTimersByTime(RELEASE_TAIL_MS);
    expect(armed()).toBe(true);

    second();
    vi.advanceTimersByTime(RELEASE_TAIL_MS);
    expect(armed()).toBe(false);
  });

  it('ignores a release called twice, so one path cannot drop another’s claim', () => {
    vi.useFakeTimers();
    const first = claimHoldGesture();
    const second = claimHoldGesture();

    first();
    first();
    vi.advanceTimersByTime(RELEASE_TAIL_MS);
    expect(armed()).toBe(true);

    second();
    vi.advanceTimersByTime(RELEASE_TAIL_MS);
    expect(armed()).toBe(false);
  });

  it('cancels the platform selection gesture while it owns the press', () => {
    vi.useFakeTimers();
    const release = claimHoldGesture();
    expect(selectStart().defaultPrevented).toBe(true);

    release();
    vi.advanceTimersByTime(RELEASE_TAIL_MS);
    expect(selectStart().defaultPrevented).toBe(false);
  });

  it('expires a claim nobody released, so selection can never be lost for good', () => {
    vi.useFakeTimers();
    claimHoldGesture();

    vi.advanceTimersByTime(MAX_HOLD_MS);
    expect(armed()).toBe(false);
    expect(selectStart().defaultPrevented).toBe(false);
  });

  it('drops a range the platform opened before the guard was armed', () => {
    vi.useFakeTimers();
    selectSomeText();
    expect(window.getSelection()?.isCollapsed).toBe(false);

    claimHoldGesture();
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
  });
});

describe('clearing the selection', () => {
  it('leaves a selection alone while a field has the focus', () => {
    const field = document.createElement('input');
    field.value = 'código de error';
    document.body.append(field);
    // Focus first: focusing a field collapses the document selection, so the
    // range has to be established after it to test the branch at all.
    field.focus();
    selectSomeText();

    clearTextSelection();

    expect(window.getSelection()?.isCollapsed).toBe(false);
  });
});
