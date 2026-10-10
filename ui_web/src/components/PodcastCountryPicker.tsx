import { For, createMemo } from 'solid-js';
import { countryName, webCountry, type PodcastCountryState } from '../lib/podcastCountry';
import { t } from '../lib/i18n';
import { toast } from '../lib/toast';
import styles from './PodcastCountryPicker.module.css';

/** A native country dropdown dressed as a globe button, in either header. */
export function PodcastCountryPicker(props: { state?: PodcastCountryState; disabled?: boolean } = {}) {
  const { countryBusy, podcastCountries, podcastCountry, choosePodcastCountry } = props.state ?? webCountry;
  const countries = createMemo(() => podcastCountries().map(code => ({ code, name: countryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name)));
  return <span class={styles.picker} title={podcastCountry() ? countryName(podcastCountry()!) : t('podcasts.country')}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18M5 6.5h14M5 17.5h14" />
    </svg>
    <select aria-label={t('podcasts.country')} value={podcastCountry() ?? ''}
      disabled={props.disabled || !podcastCountry() || countryBusy()}
      onChange={event => { const target = event.currentTarget; void choosePodcastCountry(target.value)
        .catch(() => toast.error(t('settings.toast.notSaved')))
        .finally(() => { target.value = podcastCountry() ?? ''; }); }}>
      <For each={countries()}>{item => <option value={item.code}>{item.name}</option>}</For>
    </select>
  </span>;
}
