import { openOverlay } from './overlay';
import { copyText } from './clipboard';
import { toast } from './toast';
import { t } from './i18n';
import styles from './copyLink.module.css';

export interface CopyLinkOptions {
  title: string;
  message?: string;
  value: string;
}

/**
 * Last resort when neither the share sheet nor either copy path was allowed:
 * put the text on screen, pre-selected, so it can be copied by hand. The
 * "copy" button retries — a click inside the dialog is a fresh user gesture,
 * which is exactly what the browsers that refused the first attempt wanted.
 */
export function openCopyLinkDialog(opts: CopyLinkOptions): void {
  openOverlay((close) => {
    let input: HTMLInputElement | undefined;
    const selectAll = () => {
      input?.focus();
      input?.setSelectionRange(0, opts.value.length);
    };
    const retry = async () => {
      if (await copyText(opts.value)) {
        toast.success(t('social.copied'));
        close();
        return;
      }
      selectAll();
      toast.error(t('social.copyManualHint'));
    };
    return (
      <div class={styles.dialog}>
        <h2 class={styles.title}>{opts.title}</h2>
        {opts.message ? <p class={styles.message}>{opts.message}</p> : null}
        <input
          ref={input}
          class={styles.input}
          type="text"
          readonly
          value={opts.value}
          aria-label={opts.title}
          onFocus={selectAll}
          onClick={selectAll}
        />
        <div class={styles.actions}>
          <button type="button" class={styles.cancel} onClick={close}>
            {t('common.close')}
          </button>
          <button type="button" class={styles.confirm} onClick={() => void retry()}>
            {t('social.copyAction')}
          </button>
        </div>
      </div>
    );
  });
}
