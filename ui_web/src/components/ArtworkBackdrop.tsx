import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';

/** Rasterize the wallpaper's existing filter when its image/theme/size changes.
 * CPU composition otherwise evaluates the viewport-sized blur again on every
 * scroll frame. Engines without Canvas filters retain the CSS implementation. */
export function ArtworkBackdrop(props: { src: string; active: boolean; visible: boolean; class: string; activeClass: string }) {
  let element!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [ready, setReady] = createSignal(false);
  let image: HTMLImageElement | undefined;
  let frame = 0;
  let context: CanvasRenderingContext2D | null = null;

  const paint = () => {
    if (!props.visible || !context || !image?.naturalWidth || !element.clientWidth || !element.clientHeight) return;
    const width = element.clientWidth, height = element.clientHeight;
    // Read the theme recipe with its original filter enabled. Keep it on the
    // wrapper until the bitmap is complete, so loading/failure has a fallback.
    delete element.dataset.rasterized;
    const filter = getComputedStyle(element).filter;
    // The wallpaper is blurred by dozens of CSS pixels; one raster pixel per
    // CSS pixel preserves that geometry without a DPR-squared bitmap budget.
    canvas.width = width;
    canvas.height = height;
    context.filter = filter;
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const drawnWidth = image.naturalWidth * scale, drawnHeight = image.naturalHeight * scale;
    context.drawImage(image, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
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
    <canvas ref={canvas} hidden={!ready()} />
  </div>;
}
