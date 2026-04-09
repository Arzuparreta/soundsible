/**
 * Unified trust / source badges for track rows (preview vs local library).
 */
import { esc } from './renderers.js';

export function trackTrustBadgeHtml(track) {
    if (!track || track.source !== 'preview') return '';
    return `<span class="track-trust-badge track-trust-badge--preview text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-[var(--secondary)]/25 text-[var(--secondary)] border border-[var(--secondary)]/40 flex-shrink-0" title="Streaming preview">${esc('Preview')}</span>`;
}

export function trackTrustBadgeClasses() {
    return 'track-trust-badge track-trust-badge--preview';
}
