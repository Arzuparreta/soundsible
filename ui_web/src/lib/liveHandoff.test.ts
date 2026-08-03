import { beforeEach, describe, expect, it } from 'vitest';
import { clearLiveHandoff, liveHandoffPending, secureLiveHandoffUrl } from './liveHandoff';

describe('live handoff to the secure station', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/player/');
  });

  it('addresses the Live page of the secure origin, and says why it is being opened', () => {
    expect(secureLiveHandoffUrl('https://station.tail.test'))
      .toBe('https://station.tail.test/player/#/live?handoff=live');
  });

  it('keeps the port and drops the path of the address it was given', () => {
    expect(secureLiveHandoffUrl('https://station.tail.test:8443/somewhere'))
      .toBe('https://station.tail.test:8443/player/#/live?handoff=live');
  });

  it('has nothing to offer without a secure address', () => {
    expect(secureLiveHandoffUrl(null)).toBeNull();
    expect(secureLiveHandoffUrl('')).toBeNull();
    expect(secureLiveHandoffUrl('not an origin')).toBeNull();
  });

  it('reads the marker out of the hash, which is where the router keeps a query', () => {
    expect(liveHandoffPending('#/live?handoff=live')).toBe(true);
    expect(liveHandoffPending('#/live?from=elsewhere&handoff=live')).toBe(true);
    expect(liveHandoffPending('#/live')).toBe(false);
    expect(liveHandoffPending('#/library?handoff=live')).toBe(true);
    expect(liveHandoffPending('')).toBe(false);
  });

  it('spends the marker without leaving the route, so a reload is an ordinary visit', () => {
    window.history.replaceState(null, '', '/player/#/live?handoff=live&session=7');

    clearLiveHandoff();

    expect(window.location.hash).toBe('#/live?session=7');
    expect(window.location.pathname).toBe('/player/');
    expect(liveHandoffPending()).toBe(false);
  });

  it('leaves a hash with nothing else in it clean', () => {
    window.history.replaceState(null, '', '/player/#/live?handoff=live');

    clearLiveHandoff();

    expect(window.location.hash).toBe('#/live');
  });

  it('does nothing to a page that was not handed anything', () => {
    window.history.replaceState(null, '', '/player/#/live');

    clearLiveHandoff();

    expect(window.location.hash).toBe('#/live');
  });
});
