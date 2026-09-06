import { createEffect } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import SettingsShell from '../components/SettingsShell';
import { findSection } from '../components/SettingsSections';

export default function Settings() {
  const params = useParams();
  const navigate = useNavigate();

  createEffect(() => {
    // Old links and sections whose permissions changed return to the index.
    if (params.section && !findSection(params.section)) {
      navigate('/settings', { replace: true });
    }
  });

  return (
    <SettingsShell
      section={params.section ?? null}
      onSectionChange={(id) => navigate(id ? `/settings/${id}` : '/settings')}
    />
  );
}
