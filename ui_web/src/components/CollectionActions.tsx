import { createContext, createSignal, Show, useContext } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { actions } from '../stores';
import { useCatalogCollection } from '../lib/catalogItem';
import { t } from '../lib/i18n';
import type { CatalogItem, Track } from '../types/music';
import { openActionMenu } from './ActionMenu';
import { ChangeSessionIcon, PlayIcon, QueueAddIcon, SourceIcon, menuIcons } from './icons';
import styles from './CollectionActions.module.css';

/** Placement context is shared by every collection nested inside the explorer. */
export const CollectionPlacementContext = createContext<{
  beforeQueueId?: string;
  referenceOnly?: boolean;
  changeSession?: boolean;
  intent?: string;
  onCompleted?: () => void;
}>({});

/** The primary button's verb, drawn and worded the same way the menus do. */
const PRIMARY = {
  play: { icon: PlayIcon, label: 'playlistDetail.play' },
  request: { icon: QueueAddIcon, label: 'musicExplorer.requestAll' },
  reference: { icon: SourceIcon, label: 'musicExplorer.reference' },
  change: { icon: ChangeSessionIcon, label: 'musicExplorer.change' },
} as const;

/** Collection commands use the same resolver and session actions as song rows. */
export function CollectionActions(props: {
  title: string;
  buttonClass?: string;
  tracks?: Track[];
  items?: CatalogItem[];
  auto: boolean;
  hideReferenceMenu?: boolean;
  beforeQueueId?: string;
  onCompleted?: () => void;
  onPlay?: () => void;
  onReference?: (tracks: Track[]) => void;
}) {
  const placement = useContext(CollectionPlacementContext);
  const [busy, setBusy] = createSignal(false);
  const count = () => props.items?.length ?? props.tracks?.length ?? 0;
  const use = async (purpose: 'reference' | 'request' | 'change') => {
    if (busy()) return;
    const epoch = purpose === 'change' ? actions.beginAutoSessionChange() : actions.autoSessionToken();
    const before = props.beforeQueueId ?? placement.beforeQueueId;
    const intent = placement.intent;
    const isCurrent = () => actions.autoSessionToken() === epoch && placement.intent === intent && (props.beforeQueueId ?? placement.beforeQueueId) === before;
    const changeStarted = () => {
      if (placement.intent === intent) (props.onCompleted ?? placement.onCompleted)?.();
    };
    setBusy(true);
    try {
      if (props.items) {
        if (!await useCatalogCollection(props.items, props.title, purpose, before, isCurrent, epoch, changeStarted)) return;
      }
      else if (purpose === 'change') {
        const changing = actions.changeAutoSession(props.tracks ?? [], props.title);
        changeStarted();
        await changing;
        return;
      }
      else if (purpose === 'request') await actions.placeAutoTracks(props.tracks ?? [], before);
      else if (props.onReference) props.onReference(props.tracks ?? []);
      else actions.addAutoSource(props.tracks ?? [], props.title);
      if (purpose !== 'change' && isCurrent() && placement.intent === intent) (props.onCompleted ?? placement.onCompleted)?.();
    } finally { setBusy(false); }
  };
  const purpose = () => placement.changeSession ? 'change' : placement.referenceOnly ? 'reference' : 'request';
  const primary = () => props.auto ? PRIMARY[purpose()] : PRIMARY.play;
  return <>
    <button class={props.buttonClass} type="button" data-glyph-label disabled={busy() || !count()} aria-busy={busy()} onClick={() => props.auto ? void use(purpose()) : props.onPlay?.()}>
      <span class={styles.content}>
        <Show when={!busy()}><Dynamic component={primary().icon} size={16} /></Show>
        {busy() ? t('collection.resolving') : t(primary().label)}
      </span>
    </button>
    <Show when={props.auto && !placement.referenceOnly && placement.intent !== 'auto-route' && !props.hideReferenceMenu}>
      <button type="button" disabled={busy() || !count()} aria-label={t('autoMode.route.actions', { title: props.title })} onClick={() => openActionMenu({ title: props.title, actions: [{ icon: menuIcons.source(), label: t('musicExplorer.reference'), onSelect: () => void use('reference') }, { icon: menuIcons.changeSession(), label: t('musicExplorer.change'), onSelect: () => void use('change') }] })}>•••</button>
    </Show>
  </>;
}
