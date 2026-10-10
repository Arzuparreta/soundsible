import { createMemo, For } from 'solid-js';
import { SettingsGroup, SelectRow } from './SettingsRows';
import { SettingsLoad } from './SettingsLoad';
import { t } from '../lib/i18n';
import { countryName, webCountry, type PodcastCountryState } from '../lib/podcastCountry';
import { toast } from '../lib/toast';

export function PodcastCountrySettings(props: { state?: PodcastCountryState; disabled?: boolean } = {}) {
  const { countryBusy, podcastCountries, podcastCountry, choosePodcastCountry, loadPodcastCountry } = props.state ?? webCountry;
  const countries = createMemo(() => podcastCountries().map(code => ({ code, name: countryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name)));
  return <SettingsLoad load={loadPodcastCountry}><SettingsGroup label={t('nav.podcasts')}>
    <SelectRow anchor="podcast-country" label={t('podcasts.country')} hint={t('podcasts.countryHint')}
      value={podcastCountry() ?? ''} disabled={props.disabled || countryBusy()}
      onChange={code => void choosePodcastCountry(code).catch(() => toast.error(t('settings.toast.notSaved')))}>
      <For each={countries()}>{item => <option value={item.code}>{item.name}</option>}</For>
    </SelectRow>
  </SettingsGroup></SettingsLoad>;
}
