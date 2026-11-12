import { For, Show } from 'solid-js';
import { locale, t } from '../lib/i18n';
import { serviceName, type ScrobbleServiceId, type ScrobbleServiceStatus, type ScrobbleStatus } from '../lib/scrobbling';
import type { SettingAnchor } from '../lib/settingsCatalog';
import { ActionRow, ExternalLinkRow, settingAnchor, SettingRow, SettingsGroup, SwitchRow, ValueRow } from './SettingsRows';

/** Where the settings search lands for each service. */
const ANCHORS: Record<ScrobbleServiceId, SettingAnchor> = {
  listenbrainz: settingAnchor('scrobble-listenbrainz')['data-setting'],
  lastfm: settingAnchor('scrobble-lastfm')['data-setting'],
  maloja: settingAnchor('scrobble-maloja')['data-setting'],
};

const NOTES = {
  listenbrainz: 'scrobbling.listenbrainzNote',
  lastfm: 'scrobbling.lastfmNote',
  maloja: 'scrobbling.malojaNote',
} as const;

function sentAt(seconds: number | null | undefined): string {
  if (!seconds) return t('scrobbling.never');
  return new Date(seconds * 1000).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

/** What is waiting, and why it has not gone yet. */
function delivery(item: ScrobbleServiceStatus): string {
  const count = item.pending ?? 0;
  const service = serviceName(item.service);
  if (item.state === 'reconnect') return t('scrobbling.stateReconnect', { count });
  if (item.state === 'retrying') {
    return item.error === 'api_key_rejected'
      ? t('scrobbling.stateApiKey', { count })
      : t('scrobbling.stateRetrying', { count, service });
  }
  return count > 0 ? t('scrobbling.statePending', { count }) : t('scrobbling.stateOk');
}

function account(item: ScrobbleServiceStatus): string {
  const name = item.username || serviceName(item.service);
  return item.server
    ? t('scrobbling.connectedOn', { name, server: item.server })
    : t('scrobbling.connectedAs', { name });
}

/** Pure presentation, shared by the web player and the Android app. */
export function ScrobblingView(props: {
  status: ScrobbleStatus | null;
  busy: boolean;
  unavailable?: boolean;
  /** The Last.fm page that grants access, while connecting is under way. */
  lastfmUrl: string;
  onConnect: (service: ScrobbleServiceId) => void;
  onCustomListenBrainz: () => void;
  onFinishLastfm: () => void;
  onToggle: (service: ScrobbleServiceId) => void;
  onRetry: (service: ScrobbleServiceId) => void;
  onDisconnect: (service: ScrobbleServiceId) => void;
  onLastfmApp: () => void;
  onRemoveLastfmApp: () => void;
}) {
  const off = () => props.busy || Boolean(props.unavailable);
  const admin = () => Boolean(props.status?.custom_servers);
  // Maloja is always somebody's own server, which only an admin may name. An
  // account that is not one sees it only if it connected while it was.
  const shown = () => (props.status?.services ?? []).filter((item) => item.service !== 'maloja' || admin() || item.connected);

  return (
    <>
      <For each={shown()}>
        {(item) => (
          <SettingsGroup anchor={ANCHORS[item.service]} label={serviceName(item.service)} note={t(NOTES[item.service])}>
            <Show
              when={item.connected}
              fallback={
                <Show
                  when={item.service !== 'lastfm' || item.available}
                  fallback={
                    <Show
                      when={admin()}
                      fallback={<SettingRow label={t('scrobbling.lastfmNotSetUp')} hint={t('scrobbling.lastfmAskAdmin')} />}
                    >
                      <ActionRow
                        label={t('scrobbling.lastfmAddApp')}
                        hint={t('scrobbling.lastfmAddAppHint')}
                        onClick={props.onLastfmApp}
                        disabled={off()}
                      />
                    </Show>
                  }
                >
                  <Show
                    when={item.service === 'lastfm' && props.lastfmUrl}
                    fallback={
                      <ActionRow
                        label={t('scrobbling.connectService', { service: serviceName(item.service) })}
                        hint={t(`scrobbling.connectHint.${item.service}`)}
                        onClick={() => props.onConnect(item.service)}
                        disabled={off()}
                      />
                    }
                  >
                    <ExternalLinkRow
                      href={props.lastfmUrl}
                      label={t('scrobbling.lastfmOpen')}
                      hint={t('scrobbling.lastfmOpenHint')}
                    />
                  </Show>
                  {/* Also after a reload: the link is gone from this page, but
                      access allowed through it can still be collected. */}
                  <Show when={item.service === 'lastfm' && item.authorizing}>
                    <ActionRow
                      label={t('scrobbling.lastfmFinish')}
                      hint={t('scrobbling.lastfmFinishHint')}
                      onClick={props.onFinishLastfm}
                      disabled={off()}
                    />
                  </Show>
                  <Show when={item.service === 'listenbrainz' && admin()}>
                    <ActionRow
                      label={t('scrobbling.listenbrainzOtherServer')}
                      hint={t('scrobbling.listenbrainzOtherServerHint')}
                      onClick={props.onCustomListenBrainz}
                      disabled={off()}
                    />
                  </Show>
                </Show>
              }
            >
              <SwitchRow
                label={t('scrobbling.send')}
                hint={account(item)}
                checked={Boolean(item.enabled)}
                disabled={off()}
                onChange={() => props.onToggle(item.service)}
              />
              <ValueRow label={t('scrobbling.status')} value={<span data-scrobble-state={item.state}>{delivery(item)}</span>} />
              <ValueRow label={t('scrobbling.lastSent')} value={sentAt(item.last_sent_at)} />
              <Show when={item.state === 'reconnect'}>
                <ActionRow
                  label={t('scrobbling.reconnect')}
                  hint={t('scrobbling.reconnectHint', { service: serviceName(item.service) })}
                  onClick={() => props.onConnect(item.service)}
                  disabled={off()}
                  warn
                />
              </Show>
              <Show when={item.state === 'retrying'}>
                <ActionRow label={t('scrobbling.retryNow')} onClick={() => props.onRetry(item.service)} disabled={off()} />
              </Show>
              <ActionRow
                label={t('scrobbling.disconnect')}
                hint={t('scrobbling.disconnectHint')}
                onClick={() => props.onDisconnect(item.service)}
                disabled={off()}
                danger
              />
            </Show>
          </SettingsGroup>
        )}
      </For>

      <SettingsGroup label={t('scrobbling.whatGroup')} note={t('scrobbling.whatNote')}>
        <ValueRow label={t('scrobbling.countsAfter')} value={t('scrobbling.countsAfterValue')} />
        <ValueRow label={t('scrobbling.podcasts')} value={t('scrobbling.podcastsValue')} />
      </SettingsGroup>

      <Show when={props.status?.lastfm_app?.configured}>
        <SettingsGroup label={t('scrobbling.lastfmAppGroup')} note={t('scrobbling.lastfmAppNote')}>
          <Show
            when={!props.status?.lastfm_app?.from_environment}
            fallback={<ValueRow label={t('scrobbling.apiKey')} value={t('scrobbling.fromEnvironment')} />}
          >
            <ActionRow label={t('scrobbling.lastfmReplaceApp')} onClick={props.onLastfmApp} disabled={off()} />
            <ActionRow label={t('scrobbling.removeLastfmApp')} onClick={props.onRemoveLastfmApp} disabled={off()} danger />
          </Show>
        </SettingsGroup>
      </Show>
    </>
  );
}
