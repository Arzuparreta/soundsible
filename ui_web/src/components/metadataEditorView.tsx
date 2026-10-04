import { createEffect, createSignal, onCleanup, type JSX } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import { coverUrl } from '../lib/media';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import styles from './MetadataEditor.module.css';

/**
 * Edit a track's tags (title/artist/album/album artist) and its cover (upload or
 * remove). Ports the legacy `metadata_editor.js`. The engine rewrites the file's
 * tags; fields the backend doesn't accept (year/genre) are intentionally omitted.
 */
export interface MetadataEditorHandlers {
  update(values: { title: string; artist: string; album: string; album_artist: string | null }): Promise<boolean>;
  upload(file: File): Promise<void>;
  remove(): Promise<void>;
  current?: () => boolean;
  dispose?: () => void;
}

/** Shared presentation. Audio and account-specific writes are supplied by the caller. */
export function openTrackMetadataEditor(track: Track, handlers: MetadataEditorHandlers): void {
  openOverlay((close) => {
    const [title, setTitle] = createSignal(track.title ?? '');
    const [artist, setArtist] = createSignal(track.artist ?? '');
    const [album, setAlbum] = createSignal(track.album ?? '');
    const [albumArtist, setAlbumArtist] = createSignal(track.album_artist ?? '');
    const [busy, setBusy] = createSignal(false);
    const [failed, setFailed] = createSignal(false);
    let disposed = false;
    onCleanup(() => { disposed = true; handlers.dispose?.(); });
    const current = () => !disposed && (handlers.current?.() ?? true);
    createEffect(() => { if (handlers.current && !handlers.current()) close(); });
    let fileInput: HTMLInputElement | undefined;

    const coverBg = (): JSX.CSSProperties => ({
      background: `url("${coverUrl(track.id)}") center / cover no-repeat, var(--bg-inset)`,
    });

    const save = async (e: Event) => {
      e.preventDefault();
      if (!current() || busy()) return;
      setBusy(true); setFailed(false);
      try {
        const ok = await handlers.update({ title: title().trim(), artist: artist().trim(), album: album().trim(), album_artist: albumArtist().trim() || null });
        if (ok && current()) close();
      } catch { if (current()) setFailed(true); }
      finally { if (current()) setBusy(false); }
    };
    const writeCover = async (operation: () => Promise<void>) => {
      if (!current() || busy()) return;
      setBusy(true); setFailed(false);
      try { await operation(); } catch { if (current()) setFailed(true); }
      finally { if (current()) setBusy(false); }
    };
    const onFile = (e: Event & { currentTarget: HTMLInputElement }) => {
      const file = e.currentTarget.files?.[0];
      e.currentTarget.value = '';
      if (file) void writeCover(() => handlers.upload(file));
    };
    const removeCover = () => writeCover(handlers.remove);

    return (
      <form class={styles.form} data-track-metadata-editor onSubmit={save}>
        <h2 class={styles.title}>{t('metadataEditor.title')}</h2>

        <div class={styles.coverRow}>
          <span class={styles.coverPreview} style={coverBg()} />
          <div class={styles.coverActions}>
            <button class={styles.coverBtn} type="button" disabled={busy()} onClick={() => fileInput?.click()}>
              {t('metadataEditor.uploadCover')}
            </button>
            <button class={styles.coverBtn} type="button" disabled={busy()} onClick={removeCover}>
              {t('metadataEditor.removeCover')}
            </button>
          </div>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={onFile} />
        </div>

        <label class={styles.field}>
          <span class={styles.label}>{t('metadataEditor.fieldTitle')}</span>
          <input class={styles.input} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
        </label>
        <label class={styles.field}>
          <span class={styles.label}>{t('metadataEditor.fieldArtist')}</span>
          <input class={styles.input} value={artist()} onInput={(e) => setArtist(e.currentTarget.value)} />
        </label>
        <label class={styles.field}>
          <span class={styles.label}>{t('metadataEditor.fieldAlbum')}</span>
          <input class={styles.input} value={album()} onInput={(e) => setAlbum(e.currentTarget.value)} />
        </label>
        <label class={styles.field}>
          <span class={styles.label}>{t('metadataEditor.fieldAlbumArtist')}</span>
          <input class={styles.input} value={albumArtist()} onInput={(e) => setAlbumArtist(e.currentTarget.value)} />
        </label>

        {failed() && <p role="alert">{t('common.loadFailed')}</p>}
        <div class={styles.actions}>
          <button type="button" class={styles.cancel} onClick={() => close()}>
            {t('metadataEditor.cancel')}
          </button>
          <button type="submit" class={styles.confirm} disabled={busy()}>
            {t('metadataEditor.save')}
          </button>
        </div>
      </form>
    );
  });
}
