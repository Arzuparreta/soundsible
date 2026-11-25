import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetSidebarStateForTests,
  setSidebarCollapsed,
  sidebarCollapsed,
  toggleSidebarCollapsed,
} from './sidebarState';

const dismissContextMenuMock = vi.hoisted(() => vi.fn());
vi.mock('./contextMenu', () => ({
  dismissContextMenu: dismissContextMenuMock,
}));

describe('sidebarState', () => {
  beforeEach(() => {
    resetSidebarStateForTests();
    dismissContextMenuMock.mockClear();
  });

  it('defaults to expanded and syncs document attribute and storage on toggle', () => {
    expect(sidebarCollapsed()).toBe(false);
    expect(document.documentElement.hasAttribute('data-sidebar-collapsed')).toBe(false);

    toggleSidebarCollapsed();

    expect(sidebarCollapsed()).toBe(true);
    expect(document.documentElement.hasAttribute('data-sidebar-collapsed')).toBe(true);
    expect(localStorage.getItem('sidebar:collapsed:v1')).toBe('1');
    expect(dismissContextMenuMock).toHaveBeenCalledTimes(1);

    toggleSidebarCollapsed();

    expect(sidebarCollapsed()).toBe(false);
    expect(document.documentElement.hasAttribute('data-sidebar-collapsed')).toBe(false);
    expect(localStorage.getItem('sidebar:collapsed:v1')).toBeNull();
    expect(dismissContextMenuMock).toHaveBeenCalledTimes(2);
  });

  it('ignores redundant state writes without dismissing menus', () => {
    setSidebarCollapsed(false);
    expect(dismissContextMenuMock).not.toHaveBeenCalled();

    setSidebarCollapsed(true);
    setSidebarCollapsed(true);
    expect(dismissContextMenuMock).toHaveBeenCalledTimes(1);
  });
});
