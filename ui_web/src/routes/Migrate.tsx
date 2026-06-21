import { createSignal, For, Show, createMemo } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api, ApiError, type MigrationPreview, type MigrationMatch } from '../lib/api';
import { actions } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import Button from '../components/Button';
import { toast } from '../lib/toast';
import styles from './Migrate.module.css';

type Format = 'spotify_json' | 'apple_music_csv';

const FORMATS: { id: Format; label: string; accept: string; hint: string }[] = [
  {
    id: 'spotify_json',
    label: 'Spotify',
    accept: '.json,application/json',
    hint: 'Exporta tus datos desde Spotify (o usa una herramienta de exportación) y sube el archivo JSON de la playlist.',
  },
  {
    id: 'apple_music_csv',
    label: 'Apple Music',
    accept: '.csv,text/csv',
    hint: 'En Apple Music, exporta la playlist como archivo de texto/CSV y súbelo aquí.',
  },
];

export default function Migrate() {
  const navigate = useNavigate();
  const [format, setFormat] = createSignal<Format>('spotify_json');
  const [text, setText] = createSignal('');
  const [fileName, setFileName] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [preview, setPreview] = createSignal<MigrationPreview | null>(null);
  const [selected, setSelected] = createSignal<Set<number>>(new Set<number>());
  const [playlistName, setPlaylistName] = createSignal('Importado');
  const [importing, setImporting] = createSignal(false);

  const fmtMeta = createMemo(() => FORMATS.find((f) => f.id === format())!);

  const matched = createMemo(() => (preview()?.matches ?? []).filter((m) => m.matched_track_id));
  const unmatched = createMemo(() => (preview()?.matches ?? []).filter((m) => !m.matched_track_id));

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    if (/\.csv$/i.test(file.name)) setFormat('apple_music_csv');
    else if (/\.json$/i.test(file.name)) setFormat('spotify_json');
    try {
      setText(await file.text());
    } catch {
      toast.error('No se pudo leer el archivo');
    }
  };

  const runPreview = async () => {
    const body = text().trim();
    if (!body) {
      toast.error('Añade un archivo o pega el contenido del export');
      return;
    }
    setLoading(true);
    try {
      const res = await api.migrationPreview({ format: format(), text: body });
      setPreview(res);
      // Preselect every row we found a match for.
      setSelected(new Set<number>(res.matches.filter((m) => m.matched_track_id).map((m) => m.source_index)));
    } catch (e) {
      const msg =
        e instanceof ApiError && e.status === 400
          ? 'No se pudo leer el export. ¿Es el formato correcto?'
          : e instanceof ApiError && e.status === 409
            ? 'Tu biblioteca está vacía: descarga música antes de importar.'
            : 'No se pudo previsualizar la importación';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (idx: number) => {
    setSelected((s) => {
      const n = new Set<number>(s);
      if (n.has(idx)) n.delete(idx);
      else n.add(idx);
      return n;
    });
  };

  const allSelected = createMemo(() => matched().length > 0 && matched().every((m) => selected().has(m.source_index)));
  const toggleAll = () => {
    if (allSelected()) setSelected(new Set<number>());
    else setSelected(new Set<number>(matched().map((m) => m.source_index)));
  };

  const doImport = async () => {
    const p = preview();
    const name = playlistName().trim();
    if (!name) {
      toast.error('Pon un nombre a la playlist');
      return;
    }
    const ids = matched()
      .filter((m) => selected().has(m.source_index))
      .map((m) => m.matched_track_id!)
      .filter(Boolean);
    if (ids.length === 0) {
      toast.error('Selecciona al menos una pista');
      return;
    }
    setImporting(true);
    const t = toast.loading('Importando…');
    try {
      await api.migrationImportPlaylist({ playlist_name: name, track_ids: ids, batch_id: p?.batch_id });
      await actions.syncLibrary();
      t.update('success', `Playlist "${name}" creada (${ids.length})`);
      navigate(`/playlists/${encodeURIComponent(name)}`);
    } catch (e) {
      const msg =
        e instanceof ApiError && e.status === 409
          ? 'Ya existe una playlist con ese nombre'
          : 'No se pudo crear la playlist';
      t.update('error', msg);
    } finally {
      setImporting(false);
    }
  };

  const reset = () => {
    setPreview(null);
    setSelected(new Set<number>());
  };

  return (
    <div class="view">
      <ViewHeader title="Importar biblioteca" />
      <div class={styles.scroll}>
        <Show
          when={preview()}
          fallback={
            <section class={styles.card}>
              <div class={styles.segment}>
                <For each={FORMATS}>
                  {(f) => (
                    <button
                      class={styles.seg}
                      classList={{ [styles.segOn]: format() === f.id }}
                      type="button"
                      onClick={() => setFormat(f.id)}
                    >
                      {f.label}
                    </button>
                  )}
                </For>
              </div>
              <p class={styles.hint}>{fmtMeta().hint}</p>

              <label class={styles.fileBtn}>
                <input
                  type="file"
                  accept={fmtMeta().accept}
                  class={styles.fileInput}
                  onChange={(e) => onFile(e.currentTarget.files?.[0])}
                />
                {fileName() || 'Elegir archivo…'}
              </label>

              <p class={styles.or}>o pega el contenido</p>
              <textarea
                class={styles.textarea}
                rows="6"
                placeholder={format() === 'spotify_json' ? '{ "tracks": [ … ] }' : 'Title,Artist,Album…'}
                value={text()}
                onInput={(e) => setText(e.currentTarget.value)}
              />

              <Button onClick={runPreview} disabled={loading() || !text().trim()}>
                {loading() ? 'Analizando…' : 'Previsualizar coincidencias'}
              </Button>
            </section>
          }
        >
          {(p) => (
            <>
              <section class={styles.card}>
                <h2 class={styles.statLine}>
                  {p().stats.matched} de {p().stats.total} pistas encontradas en tu biblioteca
                </h2>
                <div class={styles.chips}>
                  <span class={styles.chip}>{p().stats.auto_accept} seguras</span>
                  <span class={styles.chip}>{p().stats.needs_confirmation} a revisar</span>
                  <span classList={{ [styles.chip]: true, [styles.chipMuted]: true }}>
                    {p().stats.unmatched} sin encontrar
                  </span>
                </div>

                <label class={styles.nameRow}>
                  <span>Nombre de la playlist</span>
                  <input
                    class={styles.input}
                    value={playlistName()}
                    onInput={(e) => setPlaylistName(e.currentTarget.value)}
                  />
                </label>
              </section>

              <Show when={matched().length > 0}>
                <section class={styles.card}>
                  <div class={styles.listHead}>
                    <span class={styles.sectionTitle}>Coincidencias ({matched().length})</span>
                    <button class={styles.selectAll} type="button" onClick={toggleAll}>
                      {allSelected() ? 'Quitar todas' : 'Marcar todas'}
                    </button>
                  </div>
                  <For each={matched()}>
                    {(m) => (
                      <MatchRow m={m} checked={selected().has(m.source_index)} onToggle={() => toggle(m.source_index)} />
                    )}
                  </For>
                </section>
              </Show>

              <Show when={unmatched().length > 0}>
                <section class={styles.card}>
                  <span class={styles.sectionTitle}>Sin encontrar ({unmatched().length})</span>
                  <p class={styles.hint}>No están en tu biblioteca, así que no se importarán. Búscalas en Buscar para descargarlas.</p>
                  <For each={unmatched().slice(0, 50)}>
                    {(m) => (
                      <div class={styles.missRow}>
                        <span class={styles.missTitle}>{m.source_title || '—'}</span>
                        <span class={styles.missArtist}>{m.source_artist}</span>
                      </div>
                    )}
                  </For>
                </section>
              </Show>

              <div class={styles.actions}>
                <Button variant="secondary" onClick={reset} disabled={importing()}>
                  Atrás
                </Button>
                <Button onClick={doImport} disabled={importing() || selected().size === 0}>
                  {importing() ? 'Importando…' : `Crear playlist (${selected().size})`}
                </Button>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

function pct(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function MatchRow(props: { m: MigrationMatch; checked: boolean; onToggle: () => void }) {
  return (
    <label class={styles.matchRow}>
      <input type="checkbox" class={styles.check} checked={props.checked} onChange={props.onToggle} />
      <div class={styles.matchMeta}>
        <span class={styles.matchTitle}>{props.m.source_title || '—'}</span>
        <span class={styles.matchArtist}>{props.m.source_artist}</span>
      </div>
      <span
        class={styles.confidence}
        classList={{ [styles.review]: props.m.needs_confirmation }}
        title={props.m.auto_accept ? 'Coincidencia segura' : 'Conviene revisar'}
      >
        {pct(props.m.confidence)}
      </span>
    </label>
  );
}
