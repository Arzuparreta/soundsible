/**
 * Shared scoring for library/artist merge search (keeps app entrypoints off the full search UI module).
 */

export function scoreLibrary(track, query) {
    const q = query.toLowerCase();
    const title = (track.title || '').toLowerCase();
    const artist = (track.artist || '').toLowerCase();
    const album = (track.album || '').toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score += 100;
    else if (title.includes(q)) score += 50;
    if (artist.startsWith(q)) score += 80;
    else if (artist.includes(q)) score += 40;
    if (album.startsWith(q)) score += 60;
    else if (album.includes(q)) score += 30;
    return score;
}

export function scoreArtist(artistName, query) {
    const q = (query || '').toLowerCase();
    const name = (artistName || '').toLowerCase();
    if (!q) return 0;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 40;
    return 0;
}

export function mergeAndSortByScore(items) {
    return [...items].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.sortTitle || '').localeCompare(b.sortTitle || '');
    });
}

export function scoreOdst(item, query) {
    const q = query.toLowerCase();
    const title = (item.title || '').toLowerCase();
    const channel = (item.channel || '').toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score += 100;
    else if (title.includes(q)) score += 50;
    if (channel.startsWith(q)) score += 80;
    else if (channel.includes(q)) score += 40;
    return score;
}
