import { request, type DiscoveryNewReleasesResponse } from './api';

/** Fetch taste-profile New Releases outside the initial `api` bundle. */
export const newReleasesApi = {
  getDiscoveryNewReleases: (signal?: AbortSignal, limit = 12) =>
    request<DiscoveryNewReleasesResponse>(`/api/discovery/music/new-releases?limit=${limit}`, {
      signal,
      timeoutMs: 10000,
    }),
};
