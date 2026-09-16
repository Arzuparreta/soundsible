import { createEffect } from 'solid-js';
import { useNavigate, useParams, useSearchParams } from '@solidjs/router';
import SettingsShell from '../components/SettingsShell';
import { findSection } from '../components/SettingsSections';

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function Settings() {
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();

  const query = () => single(search.q) ?? '';
  const setting = () => single(search.setting) ?? null;

  /** The search rides along inside Settings, so going back finds the results. */
  const href = (path: string, anchor?: string) => {
    const next = new URLSearchParams();
    if (query()) next.set('q', query());
    if (anchor) next.set('setting', anchor);
    const suffix = next.toString();
    return suffix ? `${path}?${suffix}` : path;
  };

  createEffect(() => {
    // Old links and sections whose permissions changed return to the index.
    if (params.section && !findSection(params.section)) {
      navigate(href('/settings'), { replace: true });
    }
  });

  return (
    <SettingsShell
      section={params.section ?? null}
      query={query()}
      setting={setting()}
      onQueryChange={(value) => setSearch({ q: value || undefined }, { replace: true })}
      onSectionChange={(id, anchor) =>
        navigate(id ? href(`/settings/${id}`, anchor) : href('/settings'))
      }
    />
  );
}
