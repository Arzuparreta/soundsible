import { createSignal } from 'solid-js';
import type { CatalogItem } from '../types/music';
import { api } from './api';
import { itemArtist } from './catalogTrack';
import { t } from './i18n';
import { catalogItemKeys } from './playbackIdentity';
import { toast } from './toast';

type ReleaseEvidence = Pick<Parameters<typeof api.saveCatalogItem>[0], 'album' | 'album_artist' | 'track_number' | 'disc_number' | 'year'>;

export function createCatalogDownload(releaseEvidence: (item: CatalogItem) => ReleaseEvidence) {
  const [saving, setSaving] = createSignal<Set<string>>(new Set());

  const saveItem = async (item: CatalogItem) => {
    const artist = itemArtist(item);
    if (!artist || !item.title) return;
    setSaving((s) => new Set(s).add(item.id));
    try {
      const response = await api.saveCatalogItem({
        catalog_item_id: item.id,
        source: item.source,
        artist,
        title: item.title,
        duration: item.duration,
        cover: item.cover,
        external_ids: item.external_ids,
        identity_keys: catalogItemKeys(item),
        ...releaseEvidence(item),
      });
      if (response.status === 'queued') {
        toast.success(t('search.addedToDownloads'));
      } else if (response.status === 'needs_review') {
        toast.info(t('search.chooseVersion'));
      } else {
        toast.error(t('search.notSaved'));
      }
    } catch {
      toast.error(t('search.notSaved'));
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  };

  return { saving, saveItem };
}
