import { createSignal, onMount, Show } from 'solid-js';
import { useNavigate, useSearchParams } from '@solidjs/router';
import { Control, InputControl } from '../design/Control';
import { api, ApiError, type TvAuthLookup } from '../lib/api';
import { t } from '../lib/i18n';
import { user } from '../lib/session';
import styles from './TvApprove.module.css';

function normalizeCodeInput(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

function initialCodeFromLocation(param: string | string[] | undefined): string {
  const fromParam = Array.isArray(param) ? param[0] : param;
  if (fromParam) return normalizeCodeInput(fromParam);
  if (typeof window === 'undefined') return '';
  const searchCode = new URLSearchParams(window.location.search).get('code');
  return searchCode ? normalizeCodeInput(searchCode) : '';
}

function mapCodeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'not_found') return t('tvApprove.errors.notFound');
    if (err.code === 'expired') return t('tvApprove.errors.expired');
    if (err.code === 'not_pending') return t('tvApprove.errors.notPending');
    return err.message || t('tvApprove.errors.generic');
  }
  return t('tvApprove.errors.generic');
}

export default function TvApprove() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [codeInput, setCodeInput] = createSignal(initialCodeFromLocation(searchParams.code));
  const [lookup, setLookup] = createSignal<TvAuthLookup | null>(null);
  const [busy, setBusy] = createSignal<'lookup' | 'approve' | 'deny' | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [outcome, setOutcome] = createSignal<'approved' | 'denied' | null>(null);
  const [outcomeDevice, setOutcomeDevice] = createSignal<string>('');

  const accountName = () => user()?.display_name || user()?.username || '';

  async function runLookup(rawCode = codeInput()) {
    const cleaned = normalizeCodeInput(rawCode);
    setCodeInput(cleaned);
    setError(null);
    setOutcome(null);
    if (!cleaned.replace(/-/g, '')) {
      setError(t('tvApprove.errors.empty'));
      return;
    }
    setBusy('lookup');
    try {
      const match = await api.lookupTvAuthCode(cleaned);
      setLookup(match);
      setCodeInput(match.code);
    } catch (err) {
      setLookup(null);
      setError(mapCodeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function runDecision(decision: 'approve' | 'deny') {
    const active = lookup();
    if (!active || busy()) return;
    setError(null);
    setBusy(decision);
    try {
      if (decision === 'approve') {
        const res = await api.approveTvAuthCode(active.code);
        setOutcomeDevice(res.device_name || active.device_name);
        setOutcome('approved');
      } else {
        await api.denyTvAuthCode(active.code);
        setOutcomeDevice(active.device_name);
        setOutcome('denied');
      }
      setLookup(null);
    } catch (err) {
      setError(mapCodeError(err));
    } finally {
      setBusy(null);
    }
  }

  function resetForm() {
    setCodeInput('');
    setLookup(null);
    setOutcome(null);
    setOutcomeDevice('');
    setError(null);
  }

  onMount(() => {
    const initial = codeInput();
    if (initial.replace(/-/g, '').length >= 6) {
      void runLookup(initial);
    }
  });

  return (
    <section class={styles.page} aria-labelledby="tv-approve-heading">
      <div class={styles.card}>
        <header class={styles.header}>
          <h1 id="tv-approve-heading" class={styles.title}>{t('tvApprove.title')}</h1>
          <p class={styles.subtitle}>{t('tvApprove.subtitle')}</p>
          <Show when={accountName()}>
            <p class={styles.accountBadge}>{t('tvApprove.signedInAs', { name: accountName() })}</p>
          </Show>
        </header>

        <Show when={!outcome()}>
          <form
            class={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              void runLookup();
            }}
          >
            <label class={styles.fieldLabel} for="tv-approve-code">
              {t('tvApprove.codeLabel')}
            </label>
            <div class={styles.inputRow}>
              <InputControl
                id="tv-approve-code"
                class={styles.codeInput}
                type="text"
                autocomplete="off"
                autocapitalize="characters"
                spellcheck={false}
                placeholder={t('tvApprove.codePlaceholder')}
                value={codeInput()}
                onInput={(e) => setCodeInput(e.currentTarget.value)}
              />
              <Control
                type="submit"
                class={styles.secondaryBtn}
                disabled={busy() !== null}
              >
                {busy() === 'lookup' ? t('tvApprove.lookingUp') : t('tvApprove.lookup')}
              </Control>
            </div>
          </form>
        </Show>

        <Show when={error()}>
          <p class={styles.errorBanner} role="alert">{error()}</p>
        </Show>

        <Show when={lookup()}>
          {(match) => (
            <div class={styles.confirmBox}>
              <div class={styles.detailRow}>
                <span class={styles.detailLabel}>{t('tvApprove.codeLabel')}</span>
                <strong class={styles.codeValue}>{match().code}</strong>
              </div>
              <div class={styles.detailRow}>
                <span class={styles.detailLabel}>{t('tvApprove.deviceLabel')}</span>
                <strong class={styles.detailValue}>{match().device_name}</strong>
              </div>
              <div class={styles.actionRow}>
                <Control
                  class={styles.primaryBtn}
                  disabled={busy() !== null}
                  onClick={() => void runDecision('approve')}
                >
                  {busy() === 'approve' ? t('tvApprove.approving') : t('tvApprove.approve')}
                </Control>
                <Control
                  class={styles.dangerBtn}
                  disabled={busy() !== null}
                  onClick={() => void runDecision('deny')}
                >
                  {busy() === 'deny' ? t('tvApprove.denying') : t('tvApprove.deny')}
                </Control>
              </div>
            </div>
          )}
        </Show>

        <Show when={outcome() === 'approved'}>
          <div class={styles.successBox} role="status">
            <h2 class={styles.outcomeTitle}>{t('tvApprove.approvedTitle')}</h2>
            <p class={styles.outcomeBody}>
              {t('tvApprove.approvedBody', {
                device: outcomeDevice(),
                name: accountName(),
              })}
            </p>
            <div class={styles.actionRow}>
              <Control class={styles.secondaryBtn} onClick={resetForm}>
                {t('tvApprove.another')}
              </Control>
              <Control class={styles.secondaryBtn} onClick={() => navigate('/settings/devices')}>
                {t('tvApprove.backToDevices')}
              </Control>
            </div>
          </div>
        </Show>

        <Show when={outcome() === 'denied'}>
          <div class={styles.neutralBox} role="status">
            <h2 class={styles.outcomeTitle}>{t('tvApprove.deniedTitle')}</h2>
            <p class={styles.outcomeBody}>{t('tvApprove.deniedBody')}</p>
            <div class={styles.actionRow}>
              <Control class={styles.secondaryBtn} onClick={resetForm}>
                {t('tvApprove.another')}
              </Control>
              <Control class={styles.secondaryBtn} onClick={() => navigate('/settings/devices')}>
                {t('tvApprove.backToDevices')}
              </Control>
            </div>
          </div>
        </Show>

        <Show when={!outcome()}>
          <div class={styles.footerRow}>
            <Control class={styles.linkBtn} onClick={() => navigate('/settings/devices')}>
              {t('tvApprove.backToDevices')}
            </Control>
          </div>
        </Show>
      </div>
    </section>
  );
}
