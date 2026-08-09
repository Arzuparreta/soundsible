import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubsonicAccessPanel } from './SubsonicAccessPanel';

const { apiMock, confirmMock, copyMock } = vi.hoisted(() => ({
  apiMock: {
    getSubsonicAccess: vi.fn(),
    createSubsonicAccess: vi.fn(),
    revokeSubsonicAccess: vi.fn(),
  },
  confirmMock: vi.fn(),
  copyMock: vi.fn(),
}));

vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/confirm', () => ({ confirmDialog: confirmMock }));
vi.mock('../lib/clipboard', () => ({ copyText: copyMock }));

const UNCONFIGURED = {
  username: 'ana',
  configured: false,
  created_at: null,
  last_used_at: null,
  last_client: null,
};

const CONFIGURED = {
  username: 'ana',
  configured: true,
  created_at: '2026-08-09T10:00:00Z',
  last_used_at: '2026-08-09T11:00:00Z',
  last_client: 'Amperfy',
};

describe('Subsonic access panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSubsonicAccess.mockResolvedValue({ ...UNCONFIGURED });
    apiMock.createSubsonicAccess.mockResolvedValue({ ...CONFIGURED, password: 'kqrt-9wxm-2bqf-7hnd' });
    apiMock.revokeSubsonicAccess.mockResolvedValue({ ...UNCONFIGURED });
    confirmMock.mockResolvedValue(true);
    copyMock.mockResolvedValue(true);
  });

  it('offers to generate a password when nothing is set up yet', async () => {
    render(() => <SubsonicAccessPanel />);
    await waitFor(() => expect(screen.getByText('ana')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Generate a password/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revoke access/ })).not.toBeInTheDocument();
  });

  it('shows the new password once and does not ask before the first one', async () => {
    render(() => <SubsonicAccessPanel />);
    await waitFor(() => expect(screen.getByText('ana')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Generate a password/ }));

    await waitFor(() => expect(screen.getByText('kqrt-9wxm-2bqf-7hnd')).toBeInTheDocument());
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('asks before replacing a password other apps are already using', async () => {
    apiMock.getSubsonicAccess.mockResolvedValue({ ...CONFIGURED });
    render(() => <SubsonicAccessPanel />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Generate a new password/ })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /Generate a new password/ }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledOnce());
    expect(apiMock.createSubsonicAccess).toHaveBeenCalledOnce();
  });

  it('does not replace the password when the question is declined', async () => {
    apiMock.getSubsonicAccess.mockResolvedValue({ ...CONFIGURED });
    confirmMock.mockResolvedValue(false);
    render(() => <SubsonicAccessPanel />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Generate a new password/ })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /Generate a new password/ }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledOnce());
    expect(apiMock.createSubsonicAccess).not.toHaveBeenCalled();
  });

  it('revoking clears the password and the revoke option with it', async () => {
    apiMock.getSubsonicAccess.mockResolvedValue({ ...CONFIGURED });
    render(() => <SubsonicAccessPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Revoke access/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Revoke access/ }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Revoke access/ })).not.toBeInTheDocument(),
    );
    expect(apiMock.revokeSubsonicAccess).toHaveBeenCalledOnce();
  });

  it('shows when the credential was last used, and by what', async () => {
    apiMock.getSubsonicAccess.mockResolvedValue({ ...CONFIGURED });
    render(() => <SubsonicAccessPanel />);
    await waitFor(() => expect(screen.getByText('Amperfy')).toBeInTheDocument());
  });

  it('copies the server address', async () => {
    render(() => <SubsonicAccessPanel />);
    await waitFor(() => expect(screen.getByText('ana')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Copy the address/ }));

    await waitFor(() => expect(copyMock).toHaveBeenCalledWith(window.location.origin));
  });

  it('survives an engine that cannot answer', async () => {
    apiMock.getSubsonicAccess.mockRejectedValue(new Error('offline'));
    render(() => <SubsonicAccessPanel />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Generate a password/ })).toBeInTheDocument(),
    );
  });
});
