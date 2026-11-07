/** Bounded URL hints shared by img and CSS renderers; never image bodies. */
export const previewFallbacks = new Map<string, string>();
export const rejectedPreviews = new Set<string>();

export function artworkFallback(src?: string | null): string | undefined {
  if (!src) return undefined;
  const previous = previewFallbacks.get(src);
  if (previous) return previous;
  try {
    const url = new URL(src);
    const match = url.pathname.match(/^\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\/(maxresdefault|hq720|sddefault|hqdefault)\.(?:jpg|webp)$/);
    if (url.protocol === 'https:' && ['img.youtube.com', 'i.ytimg.com'].includes(url.hostname) && match)
      return `https://i.ytimg.com/vi/${match[1]}/mqdefault.jpg`;
  } catch { /* a local artwork URL has its own error state */ }
  return undefined;
}

export function rejectPreviewArtwork(src?: string | null): void {
  if (!src || !previewFallbacks.has(src)) return;
  rejectedPreviews.add(src);
  if (rejectedPreviews.size > 256) rejectedPreviews.delete(rejectedPreviews.values().next().value!);
}
