/**
 * Discovery Service — Deezer metadata via Station proxy.
 * Browsers cannot call api.deezer.com (no CORS); the engine proxies allowlisted GET paths.
 */

import { store } from './store.js';
import { Haptics } from './haptics.js';
import * as renderers from './renderers.js';
import { Resolver } from './resolver.js';
import { getApiBase } from './config.js';

function deezerProxyUrl(endpoint) {
  const host =
    store?.state?.activeHost ||
    (typeof window !== 'undefined' ? window.location.hostname : '') ||
    'localhost';
  const slug = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  return `${getApiBase(host)}/api/discovery/deezer/${slug}`;
}

/** First string URL from Deezer playlist/album/track-shaped objects (picture_* vs cover_*). */
function deezerCoverUrl(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj.trim();
  if (typeof obj !== 'object') return '';
  const keys = [
    'picture_xl', 'picture_big', 'picture_medium', 'picture_small', 'picture',
    'cover_xl', 'cover_big', 'cover_medium', 'cover_small', 'cover'
  ];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function escapeCssUrlFragment(url) {
  if (typeof url !== 'string' || !url) return '';
  return url.replace(/'/g, "\\'");
}

// Curated playlists for discovery (Spotify "Home" style)
const DISCOVERY_PLAYLISTS = [
  { id: '3155776842', title: 'Global Top 50', description: 'The hottest tracks worldwide', type: 'charts' },
  { id: '1963962142', title: 'Chill Hits', description: 'Relax and unwind', type: 'mood' },
  { id: '1479458365', title: 'Hip-Hop Central', description: 'The best in hip-hop', type: 'genre' },
  { id: '1306932615', title: 'Rock Classics', description: 'Legendary rock anthems', type: 'genre' },
  { id: '908622995', title: 'Electronic Rising', description: 'New electronic music', type: 'genre' },
  { id: '599273585', title: 'Workout Beast', description: 'Fuel your workout', type: 'mood' },
  { id: '498538565', title: 'Focus Flow', description: 'Concentration music', type: 'mood' },
  { id: '354949861', title: 'Party Anthems', description: 'Get the party started', type: 'mood' },
  { id: '749497422', title: 'Indie Mix', description: 'Alternative discoveries', type: 'genre' },
  { id: '1109731', title: 'Jazz Vibes', description: 'Smooth jazz collection', type: 'genre' }
];

class DiscoveryService {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes
    this.isLoading = false;
    this.currentTracks = [];
  }

  /**
   * Fetch from Deezer API with caching
   */
  async fetchDeezer(endpoint) {
    const cacheKey = endpoint;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    try {
      const response = await fetch(deezerProxyUrl(endpoint));
      if (!response.ok) throw new Error('Deezer API error');

      const data = await response.json();

      this.cache.set(cacheKey, {
        data,
        timestamp: Date.now()
      });

      return data;
    } catch (error) {
      console.error('Discovery fetch error:', error);
      return null;
    }
  }

  /**
   * Fetch curated playlists (Home section)
   */
  async fetchPlaylists() {
    const playlists = [];

    for (const playlist of DISCOVERY_PLAYLISTS) {
      const data = await this.fetchDeezer(`/playlist/${playlist.id}`);
      if (data) {
        playlists.push({
          id: data.id,
          title: data.title,
          description: playlist.description,
          cover: deezerCoverUrl(data),
          trackCount: data.nb_tracks || 0,
          tracks: data.tracks?.data || []
        });
      }
    }

    return playlists;
  }

  /**
   * Fetch top tracks for quick add
   */
  async fetchTopTracks(limit = 50) {
    const data = await this.fetchDeezer(`/chart?limit=${limit}`);
    if (!data || !data.tracks) return [];

    return data.tracks.data.map(track => this.normalizeTrack(track));
  }

  /**
   * Search Deezer for tracks
   */
  async search(query, limit = 20) {
    if (!query.trim()) return [];

    const data = await this.fetchDeezer(`/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!data || !data.data) return [];

    return data.data.map(track => this.normalizeTrack(track));
  }

  /**
   * Fetch similar tracks based on a seed track
   */
  async fetchSimilarTrack(trackId) {
    // Use Deezer's recommendation endpoint
    const data = await this.fetchDeezer(`/track/${trackId}`);
    if (!data) return [];

    // Get similar tracks via artist
    const artistData = await this.fetchDeezer(`/artist/${data.artist.id}/top?limit=10`);
    if (!artistData || !artistData.data) return [];

    return artistData.data
      .filter(t => t.id != trackId)
      .map(track => this.normalizeTrack(track));
  }

  /**
   * Normalize Deezer track to our format
   */
  normalizeTrack(track) {
    return {
      id: `deezer_${track.id}`,
      deezerId: track.id,
      title: track.title || 'Unknown',
      artist: track.artist?.name || 'Unknown Artist',
      album: track.album?.title || '',
      duration: track.duration || 0,
      cover: deezerCoverUrl(track.album) || this.placeholderCover,
      preview: track.preview || ''
    };
  }

  get placeholderCover() {
    return store?.placeholderCoverUrl || '';
  }

  /**
   * Clear cache (useful for testing or when user wants fresh data)
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cached tracks for instant display
   */
  getCachedTracks() {
    return this.currentTracks;
  }

  /**
   * Pre-warm cache with top tracks and playlists
   */
  async warmCache() {
    if (this.isLoading) return;
    this.isLoading = true;

    try {
      await Promise.all([
        this.fetchTopTracks(30),
        this.fetchPlaylists()
      ]);
    } finally {
      this.isLoading = false;
    }
  }
}

export const discoveryService = new DiscoveryService();

/**
 * Discovery UI Management
 */
class DiscoveryUI {
  constructor() {
    this.container = null;
    this.currentView = 'home'; // home, search, playlist
    this.currentPlaylist = null;
  }

  init(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.renderHome();
    this.bindEvents();
  }

  async renderHome() {
    this.currentView = 'home';
    this.container.innerHTML = '<div class="discovery-loading text-center py-10 text-[var(--text-dim)]">Loading discoveries...</div>';

    const playlists = await discoveryService.fetchPlaylists();
    const topTracks = await discoveryService.fetchTopTracks();
    discoveryService.currentTracks = topTracks;

    this.container.innerHTML = this.buildHomeHtml(playlists, topTracks);
    this.bindEvents();
  }

  async renderSearchResults(query) {
    this.currentView = 'search';
    this.container.innerHTML = '<div class="discovery-loading text-center py-10 text-[var(--text-dim)]">Searching...</div>';

    const tracks = await discoveryService.search(query);
    discoveryService.currentTracks = tracks;

    this.container.innerHTML = this.buildSearchResultsHtml(query, tracks);
    this.bindEvents();
  }

  buildSearchResultsHtml(query, tracks) {
    if (tracks.length === 0) {
      return `<div class="text-center py-10 text-[var(--text-dim)]">No results found for "${this.esc(query)}"</div>`;
    }

    let html = `
      <div class="discovery-search-results space-y-6">
        <section>
          <h2 class="text-lg font-bold text-[var(--text-main)] mb-4">Results for "${this.esc(query)}"</h2>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
            ${tracks.slice(0, 20).map(track => this.buildCardHtml(track)).join('')}
          </div>
        </section>
      </div>
    `;

    return html;
  }

  buildHomeHtml(playlists, tracks) {
    let html = `
      <div class="discovery-home space-y-8">
        <!-- Quick Add Section -->
        <section>
          <h2 class="text-lg font-bold text-[var(--text-main)] mb-4">Today's Top Hits</h2>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
            ${tracks.slice(0, 12).map(track => this.buildCardHtml(track)).join('')}
          </div>
        </section>

        <!-- Playlists Section -->
        <section>
          <h2 class="text-lg font-bold text-[var(--text-main)] mb-4">Browse by Mood & Genre</h2>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            ${playlists.map(pl => this.buildPlaylistCardHtml(pl)).join('')}
          </div>
        </section>
      </div>
    `;

    return html;
  }

  buildCardHtml(track) {
    const coverUrl =
      (typeof track.cover === 'string' && track.cover) ||
      deezerCoverUrl(track.album) ||
      this.placeholderCover;
    const coverStyle = coverUrl ? `background-image: url('${escapeCssUrlFragment(coverUrl)}')` : '';

    return `
      <div class="discovery-track-card group cursor-pointer" data-track-id="${track.id}" data-deezer-id="${track.deezerId}">
        <div class="aspect-square rounded-xl overflow-hidden bg-[var(--bg-surface)] bg-cover bg-center mb-3 shadow-sm transition-transform group-hover:scale-105" style="${coverStyle}"></div>
        <h3 class="font-semibold text-sm text-[var(--text-main)] truncate">${this.esc(track.title)}</h3>
        <p class="text-xs text-[var(--text-dim)] truncate">${this.esc(track.artist)}</p>
        <button class="add-to-queue-btn absolute bottom-2 right-2 w-10 h-10 rounded-full bg-[var(--accent)] text-[var(--text-on-accent)] opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-lg" aria-label="Add to queue">
          <i class="fas fa-plus text-xs"></i>
        </button>
      </div>
    `;
  }

  buildPlaylistCardHtml(playlist) {
    const coverUrl =
      (typeof playlist.cover === 'string' && playlist.cover) || this.placeholderCover;
    const coverStyle = coverUrl ? `background-image: url('${escapeCssUrlFragment(coverUrl)}')` : '';

    return `
      <div class="discovery-playlist-card group cursor-pointer" data-playlist-id="${playlist.id}">
        <div class="aspect-square rounded-xl overflow-hidden bg-[var(--bg-surface)] bg-cover bg-center mb-3 shadow-sm transition-transform group-hover:scale-105" style="${coverStyle}"></div>
        <h3 class="font-semibold text-sm text-[var(--text-main)] truncate">${this.esc(playlist.title)}</h3>
        <p class="text-xs text-[var(--text-dim)] truncate">${this.esc(playlist.description)}</p>
        <span class="text-[10px] text-[var(--text-dim)] uppercase tracking-wide">${playlist.trackCount} tracks</span>
      </div>
    `;
  }

  renderPlaylist(playlist) {
    this.currentView = 'playlist';
    this.currentPlaylist = playlist;

    const tracks = playlist.tracks || [];

    this.container.innerHTML = `
      <div class="discovery-playlist space-y-6">
        <div class="flex items-center gap-4 mb-6">
          <button class="back-btn text-[var(--text-dim)] hover:text-[var(--text-main)] transition-colors" aria-label="Go back">
            <i class="fas fa-arrow-left"></i>
          </button>
          <div class="flex-1">
            <img src="${(typeof playlist.cover === 'string' ? playlist.cover : '').replace(/"/g, '&quot;')}" alt="${this.esc(playlist.title)}" class="w-24 h-24 rounded-xl shadow-lg mb-3">
            <h1 class="text-2xl font-bold text-[var(--text-main)]">${this.esc(playlist.title)}</h1>
            <p class="text-sm text-[var(--text-dim)]">${playlist.description} • ${playlist.trackCount} tracks</p>
          </div>
        </div>

        <div class="discovery-playlist-tracks space-y-2">
          ${tracks.map((track, index) => this.buildTrackRowHtml(track, index)).join('')}
        </div>
      </div>
    `;

    this.bindEvents();
  }

  buildTrackRowHtml(track, index) {
    const rowId = typeof track.id === 'number' || typeof track.id === 'string' ? `deezer_${track.id}` : track.id;
    const coverUrl = deezerCoverUrl(track.album) || this.placeholderCover;
    const coverStyle = coverUrl ? `background-image: url('${escapeCssUrlFragment(coverUrl)}')` : '';

    return `
      <div class="discovery-track-row flex items-center gap-3 p-2 rounded-lg hover:bg-[var(--bg-surface)] transition-colors group" data-track-id="${rowId}">
        <span class="text-xs text-[var(--text-dim)] w-6">${index + 1}</span>
        <div class="w-12 h-12 rounded-lg bg-cover bg-center flex-shrink-0" style="${coverStyle}"></div>
        <div class="flex-1 min-w-0">
          <div class="font-medium text-sm text-[var(--text-main)] truncate">${this.esc(track.title)}</div>
          <div class="text-xs text-[var(--text-dim)] truncate">${this.esc(track.artist?.name)}</div>
        </div>
        <button class="add-to-queue-btn w-10 h-10 rounded-full bg-[var(--bg-surface)] hover:bg-[var(--accent)] hover:text-[var(--text-on-accent)] transition-colors flex items-center justify-center" aria-label="Add to queue">
          <i class="fas fa-plus text-xs"></i>
        </button>
        <span class="text-xs text-[var(--text-dim)] tabular-nums">${this.formatDuration(track.duration)}</span>
      </div>
    `;
  }

  formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  get placeholderCover() {
    return store?.placeholderCoverUrl || '';
  }

  esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  bindEvents() {
    if (!this.container) return;

    // Track card clicks
    this.container.querySelectorAll('.discovery-track-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.add-to-queue-btn')) return;

        const trackId = card.dataset.trackId;
        const deezerId = card.dataset.deezerId;
        this.handleTrackClick(trackId, deezerId);
      });

      const addBtn = card.querySelector('.add-to-queue-btn');
      if (addBtn) {
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const deezerId = card.dataset.deezerId;
          this.handleAddToQueue(deezerId);
        });
      }
    });

    // Playlist card clicks
    this.container.querySelectorAll('.discovery-playlist-card').forEach(card => {
      card.addEventListener('click', async () => {
        const playlistId = card.dataset.playlistId;
        await this.loadAndRenderPlaylist(playlistId);
      });
    });

    // Back button
    const backBtn = this.container.querySelector('.back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        this.renderHome();
      });
    }

    // Playlist track adds
    this.container.querySelectorAll('.discovery-playlist-tracks .add-to-queue-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest('.discovery-track-row');
        const deezerId = row?.dataset?.trackId?.replace('deezer_', '');
        if (deezerId) {
          this.handleAddToQueue(deezerId);
        }
      });
    });
  }

  async handleTrackClick(trackId, deezerId) {
    Haptics.tick();
    // For now, just add to queue on click
    await this.handleAddToQueue(deezerId);
  }

  async handleAddToQueue(deezerId) {
    Haptics.tick();

    const track = discoveryService.getCachedTracks().find(t => t.deezerId === deezerId);
    if (!track) {
      // Fetch track details if not cached
      const data = await discoveryService.fetchDeezer(`/track/${deezerId}`);
      if (data) {
        await this.queuePreviewTrack(data);
      }
    } else {
      await this.queuePreviewTrack(track);
    }

    if (typeof window.showToast === 'function') {
      window.showToast('Added to preview queue');
    }
  }

  async queuePreviewTrack(track) {
    // Create a preview item for the queue
    const preview = {
      video_id: `deezer_${track.deezerId || track.id}`,
      title: track.title,
      artist: track.artist,
      duration: track.duration || 0,
      thumbnail: track.cover
    };

    try {
      const apiBase = store.apiBase;
      const res = await fetch(`${apiBase}/api/playback/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview })
      });

      if (res.ok) {
        await store.syncQueue();
      }
    } catch (err) {
      console.error('Add to queue error:', err);
    }
  }

  async loadAndRenderPlaylist(playlistId) {
    const data = await discoveryService.fetchDeezer(`/playlist/${playlistId}`);
    if (!data) return;

    const playlist = {
      id: data.id,
      title: data.title,
      description: data.description || 'Playlist',
      cover: deezerCoverUrl(data),
      trackCount: data.nb_tracks || 0,
      tracks: data.tracks?.data || []
    };

    this.renderPlaylist(playlist);
  }
}

export const discoveryUI = new DiscoveryUI();

/**
 * Initialize discovery view
 */
export function initDiscovery(containerId) {
  discoveryUI.init(containerId);

  // Pre-warm cache in background
  discoveryService.warmCache();
}

/**
 * Search discovery tracks (for when user types in search bar)
 */
export async function searchDiscovery(query) {
  if (!query || !query.trim()) {
    // Show home view when search is empty
    discoveryUI.renderHome();
    return [];
  }
  return discoveryService.search(query);
}
