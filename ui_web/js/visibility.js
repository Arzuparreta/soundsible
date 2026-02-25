export function isVisible() {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
}

export function onChange(callback) {
    if (typeof document === 'undefined') return () => {};
    const handler = () => callback(isVisible());
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
}
