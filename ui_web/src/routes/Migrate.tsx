import { createSignal, For, Show, createMemo } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api, ApiError, type MigrationPreview, type MigrationMatch } from '../lib/api';
import { actions } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import Button from '../components/Button';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import styles from './Migrate.module.css';

type Format = 'spotify_json' | 'apple_music_csv';

const FORMATS: { id: Format; label: () => string; accept: string; hint: () => string }[] = [
  {
    id: 'spotify_json',
    label: () => t('migrate.spotify'),
    accept: '.json,application/json',
    hint: () => t('migrate.spotifyHint'),
  },
  {
    id: 'apple_music_csv',
    label: () => t('migrate.apple'),
    accept: '.csv,text/csv',
    hint: () => t('migrate.appleHint'),
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
  const [playlistName, setPlaylistName] = createSignal(t('migrate.defaultName'));
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
      toast.error(t('migrate.toast.readFailed'));
    }
  };

  const runPreview = async () => {
    const body = text().trim();
    if (!body) {
      toast.error(t('migrate.toast.empty'));
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
          ? t('migrate.toast.badFormat')
          : e instanceof ApiError && e.status === 409
            ? t('migrate.toast.libraryEmpty')
            : t('migrate.toast.previewFailed');
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
      toast.error(t('migrate.toast.nameRequired'));
      return;
    }
    const ids = matched()
      .filter((m) => selected().has(m.source_index))
      .map((m) => m.matched_track_id!)
      .filter(Boolean);
    if (ids.length === 0) {
      toast.error(t('migrate.toast.selectOne'));
      return;
    }
    setImporting(true);
    const h = toast.loading(t('migrate.toast.importing'));
    try {
      await api.migrationImportPlaylist({ playlist_name: name, track_ids: ids, batch_id: p?.batch_id });
      await actions.syncLibrary();
      h.update('success', t('migrate.toast.created', { name, count: ids.length }));
      navigate(`/playlists/${encodeURIComponent(name)}`);
    } catch (e) {
      const msg =
        e instanceof ApiError && e.status === 409
          ? t('migrate.toast.dupe')
          : t('migrate.toast.createFailed');
      h.update('error', msg);
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
      <ViewHeader title={t('migrate.title')} />
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
                      {f.label()}
                    </button>
                  )}
                </For>
              </div>
              <p class={styles.hint}>{fmtMeta().hint()}</p>

              <label class={styles.fileBtn}>
                <input
                  type="file"
                  accept={fmtMeta().accept}
                  class={styles.fileInput}
                  onChange={(e) => onFile(e.currentTarget.files?.[0])}
                />
                {fileName() || t('migrate.chooseFile')}
              </label>

              <p class={styles.or}>{t('migrate.orPaste')}</p>
              <textarea
                class={styles.textarea}
                rows="6"
                placeholder={format() === 'spotify_json' ? t('migrate.placeholderSpotify') : t('migrate.placeholderApple')}
                value={text()}
                onInput={(e) => setText(e.currentTarget.value)}
              />

              <Button onClick={runPreview} disabled={loading() || !text().trim()}>
                {loading() ? t('migrate.analyzing') : t('migrate.preview')}
              </Button>
            </section>
          }
        >
          {(p) => (
            <>
              <section class={styles.card}>
                <h2 class={styles.statLine}>
                  {t('migrate.statLine', { matched: p().stats.matched, total: p().stats.total })}
                </h2>
                <div class={styles.chips}>
                  <span class={styles.chip}>{p().stats.auto_accept} {t('migrate.chipAuto')}</span>
                  <span class={styles.chip}>{p().stats.needs_confirmation} {t('migrate.chipReview')}</span>
                  <span classList={{ [styles.chip]: true, [styles.chipMuted]: true }}>
                    {p().stats.unmatched} {t('migrate.chipUnmatched')}
                  </span>
                </div>

                <label class={styles.nameRow}>
                  <span>{t('migrate.playlistName')}</span>
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
                    <span class={styles.sectionTitle}>{t('migrate.matches', { count: matched().length })}</span>
                    <button class={styles.selectAll} type="button" onClick={toggleAll}>
                      {allSelected() ? t('migrate.deselectAll') : t('migrate.selectAll')}
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
                  <span class={styles.sectionTitle}>{t('migrate.unmatched', { count: unmatched().length })}</span>
                  <p class={styles.hint}>{t('migrate.unmatchedHint')}</p>
                  <For each={unmatched().slice(0, 50)}>
                    {(m) => (
                      <div class={styles.missRow}>
                        <span class={styles.missTitle}>{m.source_title || t('migrate.dash')}</span>
                        <span class={styles.missArtist}>{m.source_artist}</span>
                      </div>
                    )}
                  </For>
                </section>
              </Show>

              <div class={styles.actions}>
                <Button variant="secondary" onClick={reset} disabled={importing()}>
                  {t('migrate.back')}
                </Button>
                <Button onClick={doImport} disabled={importing() || selected().size === 0}>
                  {importing() ? t('migrate.toast.importing') : t('migrate.create', { count: selected().size })}
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
        <span class={styles.matchTitle}>{props.m.source_title || t('migrate.dash')}</span>
        <span class={styles.matchArtist}>{props.m.source_artist}</span>
      </div>
      <span
        class={styles.confidence}
        classList={{ [styles.review]: props.m.needs_confirmation }}
        title={props.m.auto_accept ? t('migrate.confidenceAuto') : t('migrate.confidenceReview')}
      >
        {pct(props.m.confidence)}
      </span>
    </label>
  );
}
