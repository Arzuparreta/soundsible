import { createSignal } from 'solid-js';
import { api, request } from './api';
import { locale } from './i18n';
import { user } from './session';

const [podcastCountry, setCountry] = createSignal<string>();
const [podcastCountries, setCountries] = createSignal<string[]>([]);
const [countryBusy, setBusy] = createSignal(false);
export { podcastCountry, podcastCountries, countryBusy };
let owner: string | null = null, revision = 0;
let pending: Promise<void> | undefined;

export function countryName(code: string): string {
  return new Intl.DisplayNames([locale()], { type: 'region' }).of(code.toUpperCase()) ?? code.toUpperCase();
}

export function resetPodcastCountry(): void {
  revision++; owner = null; pending = undefined; setCountry(undefined); setCountries([]); setBusy(false);
}

export function loadPodcastCountry(): Promise<void> {
  const account = user()?.id ?? '-';
  if (owner !== account) { resetPodcastCountry(); owner = account; }
  if (pending) return pending;
  const epoch = revision;
  const current = () => epoch === revision && account === (user()?.id ?? '-');
  pending = Promise.all([api.getDiscoverySettings(), request<{ countries: string[] }>('/api/discovery/podcasts/countries')])
    .then(([settings, directory]) => {
      if (!current()) return;
      const code = settings.podcast_country ?? 'us';
      if (!directory.countries.includes(code)) throw new Error('Unsupported podcast country');
      setCountries(directory.countries); setCountry(code);
    }).finally(() => { if (current()) pending = undefined; });
  return pending;
}

export async function choosePodcastCountry(code: string): Promise<void> {
  if (countryBusy() || !podcastCountries().includes(code) || code === podcastCountry()) return;
  const epoch = revision, account = user()?.id ?? '-';
  const current = () => epoch === revision && account === (user()?.id ?? '-');
  setBusy(true);
  try {
    const saved = await api.setPodcastCountry(code);
    if (!current()) return;
    if (saved.podcast_country !== code) throw new Error('Country change rejected');
    // A settings read started before this save cannot restore the old country.
    revision++; pending = undefined; setBusy(false); setCountry(code);
  } finally { if (current()) setBusy(false); }
}
