import { createSignal } from 'solid-js';
import { api, request } from './api';
import { locale } from './i18n';
import { user } from './session';

export function countryName(code: string): string {
  return new Intl.DisplayNames([locale()], { type: 'region' }).of(code.toUpperCase()) ?? code.toUpperCase();
}

/** Independent country state for a web account or native connection generation. */
export function createPodcastCountry(identity: () => string) {
  const [podcastCountry, setCountry] = createSignal<string>();
  const [podcastCountries, setCountries] = createSignal<string[]>([]);
  const [countryBusy, setBusy] = createSignal(false);
  let owner: string | null = null, revision = 0;
  let pending: Promise<void> | undefined;

  function resetPodcastCountry(): void {
    revision++; owner = null; pending = undefined; setCountry(undefined); setCountries([]); setBusy(false);
  }

  function loadPodcastCountry(): Promise<void> {
    const account = identity();
    if (owner !== account) { resetPodcastCountry(); owner = account; }
    if (pending) return pending;
    const epoch = revision;
    const current = () => epoch === revision && account === identity();
    pending = Promise.all([api.getDiscoverySettings(), request<{ countries: string[] }>('/api/discovery/podcasts/countries')])
      .then(([settings, directory]) => {
        if (!current()) return;
        const code = settings.podcast_country ?? 'us';
        if (!directory.countries.includes(code)) throw new Error('Unsupported podcast country');
        setCountries(directory.countries); setCountry(code);
      }).finally(() => { if (current()) pending = undefined; });
    return pending;
  }

  async function choosePodcastCountry(code: string): Promise<void> {
    if (countryBusy() || !podcastCountries().includes(code) || code === podcastCountry()) return;
    const epoch = revision, account = identity();
    const current = () => epoch === revision && account === identity();
    setBusy(true);
    try {
      const saved = await api.setPodcastCountry(code);
      if (!current()) return;
      if (saved.podcast_country !== code) throw new Error('Country change rejected');
      // A settings read started before this save cannot restore the old country.
      revision++; pending = undefined; setBusy(false); setCountry(code);
    } finally { if (current()) setBusy(false); }
  }

  return { podcastCountry, podcastCountries, countryBusy, loadPodcastCountry, choosePodcastCountry, resetPodcastCountry };
}
export type PodcastCountryState = ReturnType<typeof createPodcastCountry>;
const webCountry = createPodcastCountry(() => user()?.id ?? '-');
export const { podcastCountry, podcastCountries, countryBusy, loadPodcastCountry, choosePodcastCountry, resetPodcastCountry } = webCountry;
export { webCountry };
