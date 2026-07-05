import type { DiscoveryFeedSection } from './api';
import { t } from './i18n';

const MORE_LIKE_RE = /^More like (.+)$/;

const reasonKeys: Record<string, string> = {
  'Based on artists you play, save, favourite, or collect in playlists.':
    'discoverySections.reasonTasteArtist',
  "Tracks in your library you haven't played in a while.":
    'discoverySections.reasonRediscover',
  'Tracks from your playlist.': 'discoverySections.reasonPlaylist',
  'Add music, import playlists, or search to teach Soundsible what to recommend.':
    'discoverySections.reasonColdStart',
  'Local-first picks from favourites, playlists, and library structure.':
    'discoverySections.reasonMadeForLibrary',
};

export function discoverySectionTitle(section: DiscoveryFeedSection): string {
  if (section.section_type === 'from_your_playlists') return section.title;

  const moreLike = section.title.match(MORE_LIKE_RE);
  if (moreLike) return t('discoverySections.moreLike', { artist: moreLike[1] });

  switch (section.id) {
    case 'cold_start':
      return t('discoverySections.coldStart');
    case 'made_for_your_library':
      return t('discoverySections.madeForLibrary');
    case 'rediscover':
      return t('discoverySections.rediscover');
    default:
      return section.title;
  }
}

export function discoverySectionReason(section: DiscoveryFeedSection): string | undefined {
  if (!section.reason) return undefined;
  const key = reasonKeys[section.reason];
  return key ? t(key) : section.reason;
}
