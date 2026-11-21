import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';

const MAX_BACKDROP_EDGE = 240;

/** Rasterize the wallpaper's existing filter at a bounded resolution when its
 * image, theme, or aspect changes. Keeping the canvas at <= 240px cuts software
 * blur and texture bandwidth by ~80x while the GPU compositor upscales for free. */
export function ArtworkBackdrop(props: { src: string; active: boolean; visible: boolean; class: string; activeClass: string }) {
  let element!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [ready, setReady] = createSignal(false);
  let image: HTMLImageElement | undefined;
  let frame = 0;
  let context: CanvasRenderingContext2D | null = null;
  let lastKey = '';

  const paint = () => {
    if (!props.visible || !context || !image?.naturalWidth || !element.clientWidth || !element.clientHeight) return;
    const width = element.clientWidth, height = element.clientHeight;
    // Read the theme recipe with its original filter enabled. Keep it on the
    // wrapper until the bitmap is complete, so loading/failure has a fallback.
    delete element.dataset.rasterized;
    const filter = getComputedStyle(element).filter;
    const ratio = Math.min(1, MAX_BACKDROP_EDGE / Math.max(width, height));
    const drawWidth = Math.max(1, Math.round(width * ratio));
    const drawHeight = Math.max(1, Math.round(height * ratio));
    const key = `${image.currentSrc || props.src}|${filter}|${drawWidth}x${drawHeight}`;
    if (key === lastKey) {
      element.dataset.rasterized = '';
      setReady(true);
      return;
    }
    const scaledFilter = filter.replace(/blur\(([\d.]+)px\)/g, (_match, px) =>
      `blur(${(Number(px) * ratio).toFixed(2)}px)`);
    canvas.width = drawWidth;
    canvas.height = drawHeight;
    canvas.dataset.sourceFilter = filter;
    context.filter = scaledFilter;
    const scale = Math.max(drawWidth / image.naturalWidth, drawHeight / image.naturalHeight);
    const drawnWidth = image.naturalWidth * scale, drawnHeight = image.naturalHeight * scale;
    context.drawImage(image, (drawWidth - drawnWidth) / 2, (drawHeight - drawnHeight) / 2, drawnWidth, drawnHeight);
    lastKey = key;
    element.dataset.rasterized = '';
    setReady(true);
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(paint);
  };
  createEffect(() => { if (props.visible) schedule(); });

  onMount(() => {
    if (typeof CanvasRenderingContext2D === 'undefined') return;
    context = canvas.getContext('2d');
    if (!context || !('filter' in context)) { context = null; return; }
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const theme = new MutationObserver(schedule);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    schedule();
    onCleanup(() => { resize.disconnect(); theme.disconnect(); cancelAnimationFrame(frame); });
  });

  createEffect(() => {
    const source = props.src;
    setReady(false);
    lastKey = '';
    if (element) delete element.dataset.rasterized;
    image = undefined;
    if (!source) return;
    const next = new Image();
    next.onload = () => { image = next; schedule(); };
    next.src = source;
    onCleanup(() => { next.onload = null; });
  });

  return <div ref={element} class={props.class} classList={{ [props.activeClass]: props.active }}
    style={{ 'background-image': !ready() && props.src ? `url("${props.src}")` : undefined }}
    data-player-backdrop={props.active ? 'active' : 'inactive'} aria-hidden="true">
    <canvas ref={canvas} width={0} height={0} hidden={!ready()} />
  </div>;
}
