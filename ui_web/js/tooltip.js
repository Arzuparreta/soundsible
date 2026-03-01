/**
 * Hover tooltip: shows after a delay (e.g. 1s) on elements with data-hover-tooltip and optional data-hover-tooltip-delay (ms).
 */
const DELAY_DEFAULT_MS = 1000;

let tooltipEl = null;
let showTimer = null;
let currentTarget = null;

function getTooltipEl() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.setAttribute('role', 'tooltip');
    tooltipEl.className = 'hover-tooltip';
    tooltipEl.style.cssText = 'position:fixed;z-index:9999;padding:6px 10px;border-radius:8px;font-size:12px;font-weight:500;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity 0.15s ease;background:var(--bg-card, #1e1f22);color:var(--text-main,#dfe1e5);border:1px solid var(--glass-border,rgba(255,255,255,0.08));box-shadow:0 4px 12px rgba(0,0,0,0.3);';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
}

function show(text, triggerRect) {
    const el = getTooltipEl();
    el.textContent = text || '';
    el.style.opacity = '0';
    el.style.display = '';
    document.body.appendChild(el);
    const tooltipRect = el.getBoundingClientRect();
    const above = triggerRect.top - tooltipRect.height - 8;
    const left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
    el.style.left = `${Math.max(8, Math.min(left, document.documentElement.clientWidth - tooltipRect.width - 8))}px`;
    el.style.top = `${above >= 8 ? above : triggerRect.bottom + 8}px`;
    el.style.opacity = '1';
}

function hide() {
    if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
    }
    currentTarget = null;
    const el = getTooltipEl();
    el.style.opacity = '0';
    el.style.display = 'none';
}

function handleEnter(e) {
    const el = e.target.closest('[data-hover-tooltip]');
    if (!el) return;
    const text = el.getAttribute('data-hover-tooltip');
    if (!text) return;
    const delay = parseInt(el.getAttribute('data-hover-tooltip-delay'), 10) || DELAY_DEFAULT_MS;
    if (showTimer) clearTimeout(showTimer);
    if (currentTarget && currentTarget !== el) hide();
    currentTarget = el;
    showTimer = setTimeout(() => {
        showTimer = null;
        if (currentTarget === el) show(text, el.getBoundingClientRect());
    }, delay);
}

function handleLeave(e) {
    const el = e.target.closest('[data-hover-tooltip]');
    if (!el) return;
    if (el === currentTarget) hide();
}

export function initHoverTooltip() {
    document.body.addEventListener('mouseenter', handleEnter, true);
    document.body.addEventListener('mouseleave', handleLeave, true);
}
