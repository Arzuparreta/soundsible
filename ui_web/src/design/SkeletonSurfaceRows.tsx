import { For, Show } from 'solid-js';
import { t } from '../lib/i18n';
import { skeletonSlots, skeletonStatusProps } from './Skeleton';
import base from './Skeleton.module.css';
import sr from './SkeletonSurfaceRows.module.css';

export type SkeletonSurfaceRowVariant = 'episode' | 'download' | 'setting' | 'user' | 'device';

/** Route- and panel-specific skeleton rows kept outside the initial shell bundle. */
export function SkeletonSurfaceRows(props: {
  rowClass: string;
  coverClass?: string;
  count?: number;
  variant: SkeletonSurfaceRowVariant;
  decorative?: boolean;
  class?: string;
}) {
  return (
    <div
      classList={{
        [base.rows]: true,
        [sr.rows]: true,
        ...(props.class ? { [props.class]: true } : {}),
      }}
      data-variant={props.variant}
      data-decorative={props.decorative ? '' : undefined}
      {...skeletonStatusProps(props.decorative)}
    >
      <Show when={!props.decorative}>
        <span class={base.srOnly}>{t('common.loading')}</span>
      </Show>
      <For each={skeletonSlots(props.count, 4)}>
        {() => {
          const v = props.variant;
          return (
            <div class={`${props.rowClass} ${sr.row}`} data-skeleton-row aria-hidden="true">
              <Show when={v === 'episode'}>
                <span class={`${base.bone} ${sr.bone} ${base.lead} ${sr.lead}`} />
              </Show>
              <Show when={v !== 'setting'}>
                <span
                  classList={{
                    [base.bone]: true,
                    [sr.bone]: true,
                    ...(props.coverClass ? { [props.coverClass]: true } : {}),
                    [base.round]: v === 'user',
                  }}
                  data-skeleton-cover
                />
              </Show>
              <span class={`${base.rowCopy} ${sr.rowCopy}`}>
                <span class={`${base.bone} ${sr.bone} ${base.title} ${sr.title}`} />
                <Show when={v !== 'device'}>
                  <span class={`${base.bone} ${sr.bone} ${base.subtitle} ${sr.subtitle}`} />
                </Show>
                <Show when={v === 'download'}>
                  <span class={`${base.bone} ${sr.bone} ${sr.dlTrack}`} />
                  <span class={`${base.bone} ${sr.bone} ${sr.dlStatus}`} />
                </Show>
              </span>
              <span class={`${base.trailing} ${sr.trailing}`} data-skeleton-menu>
                <span class={`${base.bone} ${sr.bone} ${sr.trailBone}`} />
              </span>
            </div>
          );
        }}
      </For>
    </div>
  );
}
