import { afterEach, describe, expect, it } from 'vitest';
import { installFocusSource, isNavigationKey } from './focusSource';

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; document.body.innerHTML = ''; });

function control(html: string): HTMLElement {
  document.body.innerHTML = html;
  const element = document.body.firstElementChild as HTMLElement;
  element.focus();
  return element;
}

describe('focus source', () => {
  it('counts only navigation keys without modifiers as the keyboard', () => {
    expect(isNavigationKey(new KeyboardEvent('keydown', { key: 'Tab' }))).toBe(true);
    expect(isNavigationKey(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }))).toBe(false);
    expect(isNavigationKey(new KeyboardEvent('keydown', { key: '2', metaKey: true }))).toBe(false);
    expect(isNavigationKey(new KeyboardEvent('keydown', { key: 'Tab', altKey: true }))).toBe(false);
    expect(isNavigationKey(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false);
  });

  it('lets go of a clicked control when the window loses focus, even after a modifier', () => {
    stop = installFocusSource();
    const button = control('<button>Open</button>');
    document.dispatchEvent(new Event('pointerdown'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    window.dispatchEvent(new Event('blur'));
    expect(document.activeElement).not.toBe(button);
  });

  it('keeps focus the keyboard placed, and any text field', () => {
    stop = installFocusSource();
    const button = control('<button>Open</button>');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    window.dispatchEvent(new Event('blur'));
    expect(document.activeElement).toBe(button);

    const field = control('<input type="search">');
    document.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('blur'));
    expect(document.activeElement).toBe(field);
  });
});
