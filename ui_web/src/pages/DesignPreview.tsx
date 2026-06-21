import { createSignal, For } from 'solid-js';
import Button from '../components/Button';
import SongRow from '../components/SongRow';
import type { Track } from '../types/music';
import styles from './DesignPreview.module.css';

const SAMPLE_TRACKS: Track[] = [
  { id: 't1', title: 'Midnight Drive', artist: 'Neon Forest', duration: 214 },
  { id: 't2', title: 'Paper Cranes', artist: 'Ana Mishima', duration: 187 },
  { id: 't3', title: 'Static Bloom', artist: 'The Quiet Engine', duration: 246 },
  { id: 't4', title: 'Lowlight', artist: 'Mara Vels', duration: 203 },
  { id: 't5', title: 'Cassette Sun', artist: 'Holloway', duration: 231 },
];

const PALETTE: { name: string; token: string }[] = [
  { name: 'bg-base', token: '--bg-base' },
  { name: 'bg-raised', token: '--bg-raised' },
  { name: 'bg-elevated', token: '--bg-elevated' },
  { name: 'accent', token: '--accent' },
  { name: 'accent-soft', token: '--accent-soft' },
  { name: 'brand-gold', token: '--brand-gold' },
  { name: 'success', token: '--success' },
  { name: 'danger', token: '--danger' },
];

const TYPE_SAMPLES: { label: string; size: string; weight: string }[] = [
  { label: 'Display', size: 'var(--text-display)', weight: 'var(--fw-bold)' },
  { label: 'Heading 1', size: 'var(--text-h1)', weight: 'var(--fw-bold)' },
  { label: 'Heading 2', size: 'var(--text-h2)', weight: 'var(--fw-semibold)' },
  { label: 'Title', size: 'var(--text-title)', weight: 'var(--fw-semibold)' },
  { label: 'Body — the quick brown fox', size: 'var(--text-body)', weight: 'var(--fw-regular)' },
  { label: 'Label', size: 'var(--text-label)', weight: 'var(--fw-medium)' },
  { label: 'Caption', size: 'var(--text-caption)', weight: 'var(--fw-regular)' },
];

/**
 * Design-system preview. A review surface for the locked direction
 * (dark · dense · pro · adaptive · orange) before the real views are built.
 * Doubles as the seed of the component library.
 */
export default function DesignPreview() {
  const [activeId, setActiveId] = createSignal<string | null>('t3');

  return (
    <div class={styles.page}>
      <header class={styles.head}>
        <span class={styles.badge}>Design system · preview</span>
        <h1 class={styles.h1}>Soundsible</h1>
        <p class={styles.sub}>Dark · dense · pro — adaptive density, orange accent. SolidJS foundation.</p>
      </header>

      <section class={styles.section}>
        <h2 class={styles.h2}>Color</h2>
        <div class={styles.swatches}>
          <For each={PALETTE}>
            {(c) => (
              <div class={styles.swatch}>
                <div class={styles.chip} style={{ background: `var(${c.token})` }} />
                <span class={styles.swatchName}>{c.name}</span>
              </div>
            )}
          </For>
        </div>
      </section>

      <section class={styles.section}>
        <h2 class={styles.h2}>Type scale</h2>
        <div class={styles.typeStack}>
          <For each={TYPE_SAMPLES}>
            {(t) => (
              <div class={styles.typeRow}>
                <span class={styles.typeMeta}>{t.label}</span>
                <span style={{ 'font-size': t.size, 'font-weight': t.weight }}>
                  {t.label}
                </span>
              </div>
            )}
          </For>
        </div>
      </section>

      <section class={styles.section}>
        <h2 class={styles.h2}>Buttons</h2>
        <div class={styles.buttons}>
          <Button variant="primary">Reproducir</Button>
          <Button variant="secondary">Añadir a cola</Button>
          <Button variant="ghost">Más</Button>
          <Button variant="primary" size="sm">Pequeño</Button>
          <Button variant="secondary" disabled>Deshabilitado</Button>
        </div>
      </section>

      <section class={styles.section}>
        <h2 class={styles.h2}>Song list</h2>
        <p class={styles.hint}>
          Click para "reproducir" (fila activa); el botón ⋯ abre el menú de acciones. Solo cambia el nodo afectado.
        </p>
        <div class={styles.list}>
          <For each={SAMPLE_TRACKS}>
            {(track, i) => (
              <SongRow track={track} index={i() + 1} active={activeId() === track.id} onPlay={setActiveId} />
            )}
          </For>
        </div>
      </section>
    </div>
  );
}
