import { createEffect, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { getCachedStageImage, loadStageImage, rasterizeStageBackdrop } from '../lib/stageBackdrop';

/**
 * Renders one crossfade backdrop layer from the shared 240px blurred bitmap
 * cache without re-blurring on resize or duplicate mounts.
 */
export function ArtworkBackdrop(props: {
  src: string;
  active: boolean;
  visible: boolean;
  class: string;
  activeClass: string;
  driftClass?: string;
  hiddenClass?: string;
  hidden?: boolean;
  playerMark?: boolean;
}) {
  let element!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [ready, setReady] = createSignal(false);
  let image: HTMLImageElement | undefined;
  let frame = 0;
  let context: CanvasRenderingContext2D | null = null;
  let lastKey = '';

  const paint = () => {
    if (!props.visible || !context || !image?.naturalWidth || !element.clientWidth || !element.clientHeight) return;
    // Read the theme recipe with its original filter enabled. Keep it on the
    // wrapper until the bitmap is complete, so loading/failure has a fallback.
    delete element.dataset.rasterized;
    const filter = getComputedStyle(element).filter;
    if (!filter || filter === 'none') {
      lastKey = '';
      setReady(false);
      return;
    }
    const resolvedSrc = image.currentSrc || props.src;
    const key = `${resolvedSrc}|${filter}`;
    if (key === lastKey) {
      element.dataset.rasterized = '';
      setReady(true);
      return;
    }
    const cached = rasterizeStageBackdrop(resolvedSrc, image, filter);
    if (!cached) {
      setReady(false);
      return;
    }
    canvas.width = cached.canvas.width;
    canvas.height = cached.canvas.height;
    canvas.dataset.sourceFilter = filter;
    context.filter = 'none';
    context.drawImage(cached.canvas, 0, 0);
    // Keep the scaled blur radius on the context without re-applying blur.
    context.filter = cached.scaledFilter;
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
    const resize = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => { if (props.visible && !untrack(ready)) schedule(); })
      : null;
    resize?.observe(element);
    const theme = typeof MutationObserver === 'function'
      ? new MutationObserver(() => { if (props.visible) schedule(); })
      : null;
    theme?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-custom-colors'] });
    schedule();
    onCleanup(() => {
      resize?.disconnect();
      theme?.disconnect();
      cancelAnimationFrame(frame);
    });
  });

  createEffect(() => {
    const source = props.src;
    setReady(false);
    lastKey = '';
    if (element) delete element.dataset.rasterized;
    image = undefined;
    if (!source) return;
    const cached = getCachedStageImage(source);
    if (cached) {
      image = cached;
      schedule();
      return;
    }
    let cancelled = false;
    void loadStageImage(source).then((loaded) => {
      if (cancelled || !loaded) return;
      image = loaded;
      schedule();
    });
    onCleanup(() => { cancelled = true; });
  });

  return (
    <div
      ref={element}
      class={props.class}
      classList={{
        [props.activeClass]: props.active,
        ...(props.driftClass ? { [props.driftClass]: props.active } : {}),
        ...(props.hiddenClass ? { [props.hiddenClass]: Boolean(props.hidden) } : {}),
      }}
      style={{ 'background-image': !ready() && props.src ? `url("${props.src}")` : undefined }}
      data-player-backdrop={props.playerMark ? (props.active ? 'active' : 'inactive') : undefined}
      aria-hidden="true"
    >
      <canvas ref={canvas} width={0} height={0} hidden={!ready()} />
    </div>
  );
}
