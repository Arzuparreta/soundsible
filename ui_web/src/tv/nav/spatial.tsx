import {
  createContext,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  useContext,
  type ParentProps,
} from 'solid-js';
import type { TvNavDirection } from './input';

export type TvGroupKind = 'rail' | 'row' | 'shelf' | 'list' | 'grid' | 'modal';

export interface VirtualGroupMoveResult {
  handled: boolean;
  /** Optional edge escape direction if caller moved past start/end. */
  escape?: TvNavDirection;
}

export interface VirtualGroupHandler {
  onMove: (currentIndex: number, direction: TvNavDirection) => VirtualGroupMoveResult | boolean;
  focusIndex?: (index: number) => boolean;
  focusId?: (id: string) => boolean;
}

export interface ModalEntry {
  id: string;
  openerId: string | null;
}

interface FocusSnapshot {
  groupId: string | null;
  index: number;
}

export interface TvFocusContextValue {
  activeId: () => string | null;
  inRail: () => boolean;
  pointerMode: () => boolean;
  focusById: (id: string, opts?: { rememberContent?: boolean }) => boolean;
  restoreFocus: (id: string) => boolean;
  focusFirstInContent: (preferredId?: string | null) => boolean;
  focusRail: (preferredId?: string | null) => boolean;
  exitRail: () => boolean;
  move: (direction: TvNavDirection) => boolean;
  reconcileFocus: (fallbackGroupId?: string | null) => boolean;
  pushModal: (modalId: string, initialFocusId?: string | null) => void;
  popModal: (modalId: string) => void;
  topModalId: () => string | null;
  registerVirtualGroup: (groupId: string, handler: VirtualGroupHandler) => () => void;
  registerBackHandler: (handler: () => boolean) => () => void;
  handleBackAction: () => boolean;
  noteLastContentFocus: (id: string | null) => void;
  lastContentFocusId: () => string | null;
  snapshotScrollState: () => { mainTop: number; shelves: Record<string, number> };
  restoreScrollState: (scrollTop: number, shelves: Record<string, number>) => void;
}

const TvFocusContext = createContext<TvFocusContextValue>();

const POINTER_THRESHOLD_PX = 12;
const VIEWPORT_SCROLL_PAD_PX = 24;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  let current: HTMLElement | null = el;
  while (current) {
    if (current.hasAttribute('hidden')) return false;
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    current = current.parentElement;
  }
  return true;
}

function centerX(rect: DOMRect): number {
  return rect.left + rect.width / 2;
}

function verticalAnchorX(rect: DOMRect): number {
  // Wide banners and full-width track rows read from their leading edge,
  // so vertical hops should land near the start of the adjacent shelf/bar.
  return rect.width > 480 ? rect.left + 120 : centerX(rect);
}

function closestHorizontalMatch(
  items: HTMLElement[],
  referenceX: number,
  groupContainer: HTMLElement,
): HTMLElement {
  const scrollHost = groupContainer.closest('[data-tv-scroll-x]') as HTMLElement | null;
  if (scrollHost) {
    const port = scrollHost.getBoundingClientRect();
    const visible = items.filter((item) => {
      const r = item.getBoundingClientRect();
      return r.right >= port.left - 4 && r.left <= port.right + 4;
    });
    if (visible.length > 0) {
      return visible.reduce((best, candidate) =>
        Math.abs(centerX(candidate.getBoundingClientRect()) - referenceX) <
        Math.abs(centerX(best.getBoundingClientRect()) - referenceX)
          ? candidate
          : best,
      );
    }
  }
  return items.reduce((best, candidate) =>
    Math.abs(centerX(candidate.getBoundingClientRect()) - referenceX) <
    Math.abs(centerX(best.getBoundingClientRect()) - referenceX)
      ? candidate
      : best,
  );
}

function scrollMinimalIntoView(el: HTMLElement): void {
  const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';

  const hScroller = el.closest('[data-tv-scroll-x]') as HTMLElement | null;
  if (hScroller && typeof hScroller.scrollBy === 'function') {
    const hostRect = hScroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    if (elRect.left < hostRect.left + VIEWPORT_SCROLL_PAD_PX) {
      hScroller.scrollBy({
        left: elRect.left - (hostRect.left + VIEWPORT_SCROLL_PAD_PX),
        behavior,
      });
    } else if (elRect.right > hostRect.right - VIEWPORT_SCROLL_PAD_PX) {
      hScroller.scrollBy({
        left: elRect.right - (hostRect.right - VIEWPORT_SCROLL_PAD_PX),
        behavior,
      });
    }
  }

  const vScroller = el.closest('[data-tv-scroll-y]') as HTMLElement | null;
  if (vScroller && typeof vScroller.scrollBy === 'function') {
    const hostRect = vScroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    if (elRect.top < hostRect.top + VIEWPORT_SCROLL_PAD_PX) {
      vScroller.scrollBy({
        top: elRect.top - (hostRect.top + VIEWPORT_SCROLL_PAD_PX),
        behavior,
      });
    } else if (elRect.bottom > hostRect.bottom - VIEWPORT_SCROLL_PAD_PX) {
      vScroller.scrollBy({
        top: elRect.bottom - (hostRect.bottom - VIEWPORT_SCROLL_PAD_PX),
        behavior,
      });
    }
  }
}

export function TvFocusProvider(props: ParentProps) {
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [pointerMode, setPointerMode] = createSignal(false);
  const [modalStack, setModalStack] = createSignal<ModalEntry[]>([]);
  const [lastContentId, setLastContentId] = createSignal<string | null>(null);

  const virtualGroups = new Map<string, VirtualGroupHandler>();
  const backHandlers = new Set<() => boolean>();
  let lastSnapshot: FocusSnapshot = { groupId: null, index: 0 };
  let lastPointerPos: { x: number; y: number } | null = null;

  const topModal = () => {
    const stack = modalStack();
    return stack.length > 0 ? stack[stack.length - 1] : null;
  };

  function scopeRoot(): ParentNode {
    const modal = topModal();
    if (modal) {
      const container = document.querySelector(`[data-tv-modal="${CSS.escape(modal.id)}"]`);
      if (container) return container;
    }
    return document;
  }

  function queryFocusable(root: ParentNode = scopeRoot()): HTMLElement[] {
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-tv-id]'));
    return nodes.filter(isElementVisible);
  }

  function queryContentGroups(includeRail = false): HTMLElement[] {
    const root = scopeRoot();
    const groups = Array.from(
      root.querySelectorAll<HTMLElement>('[data-tv-group-container]'),
    ).filter((group) => {
      if (!includeRail && group.dataset.tvGroupKind === 'rail') return false;
      return Array.from(group.querySelectorAll<HTMLElement>('[data-tv-id]')).some(isElementVisible);
    });
    return groups.sort((a, b) => {
      const ao = Number(a.dataset.tvGroupOrder ?? '100');
      const bo = Number(b.dataset.tvGroupOrder ?? '100');
      if (ao !== bo) return ao - bo;
      return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    });
  }

  function findElementById(id: string | null | undefined): HTMLElement | null {
    if (!id) return null;
    const root = scopeRoot();
    const match = root.querySelector<HTMLElement>(`[data-tv-id="${CSS.escape(id)}"]`);
    return match && isElementVisible(match) ? match : null;
  }

  function focusElement(el: HTMLElement | null, opts?: { rememberContent?: boolean }): boolean {
    if (!el || !isElementVisible(el)) return false;
    const id = el.dataset.tvId ?? null;
    if (!id) return false;
    el.focus({ preventScroll: true });
    scrollMinimalIntoView(el);
    setActiveId(id);
    const groupContainer = el.closest('[data-tv-group-container]') as HTMLElement | null;
    const groupId = el.dataset.tvGroup || groupContainer?.dataset.tvGroupContainer || null;
    const groupKind = groupContainer?.dataset.tvGroupKind;
    const index = Number(el.dataset.tvIndex ?? '0');
    lastSnapshot = { groupId, index };
    if (opts?.rememberContent !== false && groupKind !== 'rail' && !topModal()) {
      setLastContentId(id);
    }
    return true;
  }

  function focusById(id: string, opts?: { rememberContent?: boolean }): boolean {
    return focusElement(findElementById(id), opts);
  }

  function restoreFocus(id: string): boolean {
    if (focusById(id)) return true;
    const root = scopeRoot();
    for (const [groupId, handler] of virtualGroups) {
      if (!id.startsWith(`${groupId}-item-`)) continue;
      const group = root.querySelector(`[data-tv-group-container="${CSS.escape(groupId)}"]`);
      if (group && handler.focusId?.(id)) return true;
    }
    return false;
  }

  function inRail(): boolean {
    const id = activeId();
    if (!id) return false;
    const el = findElementById(id);
    const group = el?.closest('[data-tv-group-container]') as HTMLElement | null;
    return group?.dataset.tvGroupKind === 'rail';
  }

  function focusRail(preferredId?: string | null): boolean {
    if (topModal()) return false;
    const rail = document.querySelector<HTMLElement>('[data-tv-group-kind="rail"]');
    if (!rail) return false;
    const items = queryFocusable(rail);
    if (!items.length) return false;
    const preferred = preferredId ? items.find((i) => i.dataset.tvId === preferredId) : null;
    const selected = items.find((i) => i.dataset.tvSelected === 'true');
    return focusElement(preferred || selected || items[0], { rememberContent: false });
  }

  function focusFirstInContent(preferredId?: string | null): boolean {
    if (preferredId && restoreFocus(preferredId)) return true;
    const groups = queryContentGroups(false);
    for (const group of groups) {
      const items = queryFocusable(group);
      if (items.length > 0) {
        const selectedTab = items.find(item => item.getAttribute('aria-selected') === 'true');
        return focusElement(selectedTab ?? items[0]);
      }
    }
    const any = queryFocusable(scopeRoot());
    return any.length > 0 ? focusElement(any[0]) : false;
  }

  function exitRail(): boolean {
    if (topModal()) return false;
    const lastId = lastContentId();
    if (lastId && restoreFocus(lastId)) return true;
    return focusFirstInContent();
  }

  function moveWithinGrid(
    items: HTMLElement[],
    currentIdx: number,
    direction: TvNavDirection,
    currentRect: DOMRect,
  ): { target: HTMLElement | null; boundary: boolean } {
    if (direction === 'left') {
      if (currentIdx === 0) return { target: null, boundary: true };
      const prev = items[currentIdx - 1];
      if (Math.abs(prev.getBoundingClientRect().top - currentRect.top) > 16) {
        return { target: null, boundary: true };
      }
      return { target: prev, boundary: false };
    }
    if (direction === 'right') {
      if (currentIdx >= items.length - 1) return { target: null, boundary: true };
      const next = items[currentIdx + 1];
      if (Math.abs(next.getBoundingClientRect().top - currentRect.top) > 16) {
        return { target: null, boundary: true };
      }
      return { target: next, boundary: false };
    }
    // Group grid items into visual rows to preserve true column alignment.
    const rows: HTMLElement[][] = [];
    for (const item of items) {
      const top = item.getBoundingClientRect().top;
      const lastRow = rows[rows.length - 1];
      if (!lastRow || Math.abs(lastRow[0].getBoundingClientRect().top - top) > 16) {
        rows.push([item]);
      } else {
        lastRow.push(item);
      }
    }
    const rowIdx = rows.findIndex((row) => row.includes(items[currentIdx]));
    if (rowIdx < 0) return { target: null, boundary: true };
    const colIdx = rows[rowIdx].indexOf(items[currentIdx]);
    const nextRowIdx = direction === 'down' ? rowIdx + 1 : rowIdx - 1;
    if (nextRowIdx < 0 || nextRowIdx >= rows.length) {
      return { target: null, boundary: true };
    }
    const targetRow = rows[nextRowIdx];
    const target = targetRow[Math.min(colIdx, targetRow.length - 1)];
    return { target, boundary: false };
  }

  function moveVerticalBetweenGroups(
    currentGroup: HTMLElement,
    direction: 'up' | 'down',
    referenceX: number,
  ): boolean {
    const groups = queryContentGroups(false);
    const idx = groups.indexOf(currentGroup);
    if (idx < 0) return focusFirstInContent();
    const nextIdx = direction === 'down' ? idx + 1 : idx - 1;
    if (nextIdx < 0 || nextIdx >= groups.length) return false;
    const nextGroup = groups[nextIdx];
    const nextItems = queryFocusable(nextGroup);
    if (!nextItems.length) return false;
    const picked = closestHorizontalMatch(nextItems, referenceX, nextGroup);
    return focusElement(picked);
  }

  function move(direction: TvNavDirection): boolean {
    setPointerMode(false);
    const current = findElementById(activeId()) ?? findElementById((document.activeElement as HTMLElement)?.dataset?.tvId);
    if (!current) {
      return topModal() ? focusFirstInContent() : focusFirstInContent(lastContentId());
    }

    const groupContainer = current.closest('[data-tv-group-container]') as HTMLElement | null;
    if (!groupContainer) return false;

    const groupKind = (groupContainer.dataset.tvGroupKind || 'row') as TvGroupKind;
    const groupId = groupContainer.dataset.tvGroupContainer || current.dataset.tvGroup || '';
    const items = queryFocusable(groupContainer);
    const currentDomIndex = items.indexOf(current);
    const logicalIndex = Number(current.dataset.tvIndex ?? String(currentDomIndex));

    const vHandler = groupId ? virtualGroups.get(groupId) : undefined;
    if (vHandler) {
      const outcome = vHandler.onMove(logicalIndex, direction);
      const handled = typeof outcome === 'boolean' ? outcome : outcome.handled;
      const escape = typeof outcome === 'boolean' ? undefined : outcome.escape;
      if (handled) return true;
      if (escape === 'left' && !topModal() && focusRail()) return true;
      if (escape === 'up' || escape === 'down') {
        return moveVerticalBetweenGroups(
          groupContainer,
          escape,
          verticalAnchorX(current.getBoundingClientRect()),
        );
      }
      return false;
    }

    if (groupKind === 'rail') {
      if (direction === 'up' && currentDomIndex > 0) {
        return focusElement(items[currentDomIndex - 1], { rememberContent: false });
      }
      if (direction === 'down' && currentDomIndex < items.length - 1) {
        return focusElement(items[currentDomIndex + 1], { rememberContent: false });
      }
      if (direction === 'right') {
        return exitRail();
      }
      return false;
    }

    if (groupKind === 'shelf' || groupKind === 'row') {
      if (direction === 'left') {
        if (currentDomIndex > 0) return focusElement(items[currentDomIndex - 1]);
        if (!topModal() && groupContainer.dataset.tvRailEdge !== 'none') {
          return focusRail();
        }
        return false;
      }
      if (direction === 'right') {
        if (currentDomIndex < items.length - 1) return focusElement(items[currentDomIndex + 1]);
        return false;
      }
      return moveVerticalBetweenGroups(
        groupContainer,
        direction,
        verticalAnchorX(current.getBoundingClientRect()),
      );
    }

    if (groupKind === 'list') {
      if (direction === 'up') {
        if (currentDomIndex > 0) return focusElement(items[currentDomIndex - 1]);
        return moveVerticalBetweenGroups(
          groupContainer,
          'up',
          verticalAnchorX(current.getBoundingClientRect()),
        );
      }
      if (direction === 'down') {
        if (currentDomIndex < items.length - 1) return focusElement(items[currentDomIndex + 1]);
        return moveVerticalBetweenGroups(
          groupContainer,
          'down',
          verticalAnchorX(current.getBoundingClientRect()),
        );
      }
      if (direction === 'left' && !topModal() && groupContainer.dataset.tvRailEdge !== 'none') {
        return focusRail();
      }
      return false;
    }

    if (groupKind === 'grid') {
      const result = moveWithinGrid(items, currentDomIndex, direction, current.getBoundingClientRect());
      if (result.target) return focusElement(result.target);
      if (result.boundary && direction === 'left' && !topModal() && groupContainer.dataset.tvRailEdge !== 'none') {
        return focusRail();
      }
      if (result.boundary && (direction === 'up' || direction === 'down')) {
        return moveVerticalBetweenGroups(
          groupContainer,
          direction,
          verticalAnchorX(current.getBoundingClientRect()),
        );
      }
      return false;
    }

    // Modal fallback linear/vertical movement inside modal root.
    if (direction === 'left' || direction === 'up') {
      if (currentDomIndex > 0) return focusElement(items[currentDomIndex - 1]);
      return false;
    }
    if (direction === 'right' || direction === 'down') {
      if (currentDomIndex < items.length - 1) return focusElement(items[currentDomIndex + 1]);
      return false;
    }
    return false;
  }

  function reconcileFocus(fallbackGroupId?: string | null): boolean {
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && active.dataset?.tvId && findElementById(active.dataset.tvId)) {
      if (activeId() !== active.dataset.tvId) setActiveId(active.dataset.tvId);
      return true;
    }
    const tracked = findElementById(activeId());
    if (tracked) {
      tracked.focus({ preventScroll: true });
      return true;
    }
    const targetGroupId = fallbackGroupId || lastSnapshot.groupId;
    if (targetGroupId) {
      const container = scopeRoot().querySelector<HTMLElement>(
        `[data-tv-group-container="${CSS.escape(targetGroupId)}"]`,
      );
      if (container) {
        const items = queryFocusable(container);
        if (items.length > 0) {
          const distance = (item: HTMLElement) => Math.abs(Number(item.dataset.tvIndex ?? 0) - lastSnapshot.index);
          const sibling = items.reduce((best, item) => distance(item) < distance(best) ? item : best);
          return focusElement(sibling);
        }
      }
    }
    if (focusFirstInContent()) return true;
    return focusRail();
  }

  function pushModal(modalId: string, initialFocusId?: string | null): void {
    const openerId = untrack(activeId);
    setModalStack((prev) => [...prev.filter((m) => m.id !== modalId), { id: modalId, openerId }]);
    queueMicrotask(() => {
      if (initialFocusId && restoreFocus(initialFocusId)) return;
      const modalRoot = document.querySelector<HTMLElement>(`[data-tv-modal="${CSS.escape(modalId)}"]`);
      if (modalRoot) {
        const items = queryFocusable(modalRoot);
        if (items.length > 0) focusElement(items[0], { rememberContent: false });
      }
    });
  }

  function popModal(modalId: string): void {
    const current = untrack(modalStack);
    const removed = current.find((m) => m.id === modalId);
    const next = current.filter((m) => m.id !== modalId);
    setModalStack(next);
    queueMicrotask(() => {
      const nextTop = next[next.length - 1];
      if (nextTop) {
        reconcileFocus();
        return;
      }
      if (removed?.openerId && restoreFocus(removed.openerId)) return;
      reconcileFocus();
    });
  }

  function registerVirtualGroup(groupId: string, handler: VirtualGroupHandler): () => void {
    virtualGroups.set(groupId, handler);
    return () => {
      if (virtualGroups.get(groupId) === handler) {
        virtualGroups.delete(groupId);
      }
    };
  }

  function registerBackHandler(handler: () => boolean): () => void {
    backHandlers.add(handler);
    return () => {
      backHandlers.delete(handler);
    };
  }

  function handleBackAction(): boolean {
    for (const handler of Array.from(backHandlers).reverse()) {
      if (handler()) return true;
    }
    return false;
  }

  function snapshotScrollState(): { mainTop: number; shelves: Record<string, number> } {
    const main = document.querySelector<HTMLElement>('[data-tv-scroll-y="main"]');
    const shelves: Record<string, number> = {};
    for (const shelf of document.querySelectorAll<HTMLElement>('[data-tv-scroll-x]')) {
      const id = shelf.dataset.tvScrollX;
      if (id) shelves[id] = shelf.scrollLeft;
    }
    return { mainTop: main?.scrollTop ?? 0, shelves };
  }

  function restoreScrollState(scrollTop: number, shelves: Record<string, number>): void {
    const main = document.querySelector<HTMLElement>('[data-tv-scroll-y="main"]');
    if (main) main.scrollTop = scrollTop;
    for (const [id, left] of Object.entries(shelves)) {
      const shelf = document.querySelector<HTMLElement>(`[data-tv-scroll-x="${CSS.escape(id)}"]`);
      if (shelf) shelf.scrollLeft = left;
    }
  }

  onMount(() => {
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      const focusable = target?.closest?.('[data-tv-id]') as HTMLElement | null;
      if (!focusable || !isElementVisible(focusable)) return;
      const modal = topModal();
      if (modal && !focusable.closest(`[data-tv-modal="${CSS.escape(modal.id)}"]`)) {
        // Enforce modal focus trap if browser Tab or click escaped the modal.
        reconcileFocus();
        return;
      }
      const id = focusable.dataset.tvId ?? null;
      if (id && id !== activeId()) {
        setActiveId(id);
        const groupContainer = focusable.closest('[data-tv-group-container]') as HTMLElement | null;
        if (groupContainer?.dataset.tvGroupKind !== 'rail' && !topModal()) {
          setLastContentId(id);
        }
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (lastPointerPos) {
        const dist = Math.hypot(e.clientX - lastPointerPos.x, e.clientY - lastPointerPos.y);
        if (dist < POINTER_THRESHOLD_PX) return;
      }
      lastPointerPos = { x: e.clientX, y: e.clientY };
      const target = (e.target as HTMLElement | null)?.closest?.('[data-tv-id]') as HTMLElement | null;
      if (!target || !isElementVisible(target)) return;
      const modal = topModal();
      if (modal && !target.closest(`[data-tv-modal="${CSS.escape(modal.id)}"]`)) return;
      setPointerMode(true);
      focusElement(target);
    };

    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    onCleanup(() => {
      document.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('pointermove', onPointerMove);
    });
  });

  const value: TvFocusContextValue = {
    activeId,
    inRail,
    pointerMode,
    focusById,
    restoreFocus,
    focusFirstInContent,
    focusRail,
    exitRail,
    move,
    reconcileFocus,
    pushModal,
    popModal,
    topModalId: () => topModal()?.id ?? null,
    registerVirtualGroup,
    registerBackHandler,
    handleBackAction,
    noteLastContentFocus: setLastContentId,
    lastContentFocusId: lastContentId,
    snapshotScrollState,
    restoreScrollState,
  };

  return <TvFocusContext.Provider value={value}>{props.children}</TvFocusContext.Provider>;
}

export function useTvFocus(): TvFocusContextValue {
  const ctx = useContext(TvFocusContext);
  if (!ctx) throw new Error('useTvFocus must be used inside TvFocusProvider');
  return ctx;
}
