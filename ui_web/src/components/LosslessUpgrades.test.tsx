import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { api, toast } = vi.hoisted(() => ({
  api: {
    getLosslessStatus: vi.fn(),
    setLosslessEnabled: vi.fn(),
    setJamendoClientId: vi.fn(),
    runLosslessNow: vi.fn(),
    pauseLossless: vi.fn(),
    resumeLossless: vi.fn(),
    cancelLossless: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../lib/api', () => ({ api }));
vi.mock('../lib/toast', () => ({ toast }));
vi.mock('../lib/i18n', () => ({
  t: (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock('../lib/confirm', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));

import { LosslessUpgrades } from './LosslessUpgrades';

const status = {
  enabled: true,
  activity: 'waiting',
  manual: { state: 'off', processed: 0 },
  budget: { tracks_examined: 0, bytes_downloaded: 0, max_tracks: 25, max_bytes: 1 },
  providers: [
    { name: 'jamendo', available: false },
    { name: 'wikimedia', available: true },
  ],
  identity_verifier_available: true,
  counts: {},
};

describe('LosslessUpgrades', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getLosslessStatus.mockResolvedValue(status);
    api.setJamendoClientId.mockResolvedValue({
      status: 'updated',
      enabled: true,
      jamendo_configured: true,
    });
  });

  it('keeps the Jamendo Client ID masked and sends it only when saved', async () => {
    const view = render(() => <LosslessUpgrades />);
    const input = await screen.findByLabelText('settings.losslessJamendoClientId');

    expect(input).toHaveAttribute('type', 'password');
    fireEvent.input(input, { target: { value: 'private-client-id' } });
    fireEvent.click(screen.getByRole('button', { name: /settings.losslessJamendoSave/ }));

    await vi.waitFor(() =>
      expect(api.setJamendoClientId).toHaveBeenCalledWith('private-client-id'),
    );
    await vi.waitFor(() => {
      expect(input).toHaveValue('');
      expect(toast.success).toHaveBeenCalledWith('settings.losslessJamendoSaved');
    });
    view.unmount();
  });
});
