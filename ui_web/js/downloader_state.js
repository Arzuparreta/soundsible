export function mergeDownloaderEvent(status, detail) {
    if (!detail?.id) return status;

    const current = status || { is_processing: true, queue: [], logs: [] };
    const queue = Array.isArray(current.queue) ? current.queue : [];

    if (detail.status === 'completed') {
        return { ...current, queue: queue.filter((item) => item.id !== detail.id) };
    }

    let found = false;
    const nextQueue = queue.map((item) => {
        if (item.id !== detail.id) return item;
        found = true;
        return { ...item, ...detail };
    });
    if (!found) nextQueue.push({ ...detail });

    return { ...current, queue: nextQueue };
}

export function getDownloadProgressView(item) {
    const status = item?.status || 'pending';
    const rawPercent = Number(item?.progress_percent);
    const hasPercent = item?.progress_percent != null && Number.isFinite(rawPercent);
    const percent = hasPercent ? Math.min(100, Math.max(0, rawPercent)) : (status === 'pending' ? 0 : null);
    const preparing = status === 'downloading'
        && percent == null
        && (item?.phase === 'preparing' || !item?.progress_percent);

    let phaseLabel = item?.phase || status;
    if (status === 'failed') {
        phaseLabel = percent == null ? 'Failed' : `Failed at ${Math.round(percent)}%`;
    } else if (item?.phase === 'preparing') {
        phaseLabel = 'Preparing';
    } else if (item?.phase === 'processing') {
        phaseLabel = 'Processing';
    } else if (item?.phase === 'downloading' || status === 'downloading') {
        phaseLabel = 'Downloading';
    } else if (status === 'pending') {
        phaseLabel = 'Pending';
    }

    return {
        percent,
        preparing,
        percentLabel: percent != null ? `${Math.round(percent)}%` : (preparing ? '…' : ''),
        phaseLabel,
        detailLabel: status === 'failed'
            ? (item?.error_message || 'The download failed.')
            : [item?.speed, item?.eta].filter(Boolean).join(' · '),
    };
}
