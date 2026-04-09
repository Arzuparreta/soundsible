/**
 * Progressive list rendering for large libraries (IntersectionObserver chunks).
 * Avoids multi-thousand-row innerHTML stalls when row metadata indexes are not required.
 */

export function attachProgressiveChunks(container, items, renderChunkHtml, options = {}) {
    const threshold = options.threshold ?? 130;
    const chunk = options.chunkSize ?? 72;
    if (!container || !items?.length) {
        if (container) container.innerHTML = '';
        return () => {};
    }
    if (items.length <= threshold) {
        container.innerHTML = renderChunkHtml(items);
        return () => {};
    }

    let offset = Math.min(chunk, items.length);
    container.innerHTML = renderChunkHtml(items.slice(0, offset));

    const sentinel = document.createElement('div');
    sentinel.className = 'progressive-list-sentinel';
    sentinel.style.height = '1px';
    sentinel.style.width = '100%';
    container.appendChild(sentinel);

    const io = new IntersectionObserver(
        (entries) => {
            if (!entries[0]?.isIntersecting) return;
            if (offset >= items.length) {
                io.disconnect();
                sentinel.remove();
                return;
            }
            const next = items.slice(offset, offset + chunk);
            sentinel.insertAdjacentHTML('beforebegin', renderChunkHtml(next));
            offset += next.length;
        },
        { root: null, rootMargin: '240px', threshold: 0 }
    );
    io.observe(sentinel);

    return () => {
        try {
            io.disconnect();
        } catch (_) {}
        if (sentinel.parentNode) sentinel.remove();
    };
}
