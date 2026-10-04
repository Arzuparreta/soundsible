import { registerPlugin } from '@capacitor/core';
import { nativeImportBody } from './engine';
import { request } from '../lib/http';
import type { MigrationJob } from '../lib/migrationApi';

interface SelectedImport { cancelled?: boolean; token?: string; name?: string; size?: number }
const importer = registerPlugin<{
  select(options: { generation: number; id: string }): Promise<SelectedImport>;
  cancel(options: { id: string }): Promise<void>;
  release(options: { token: string }): Promise<void>;
}>('SoundsibleImport');
let serial = 0;
export async function chooseNativeImport(generation: number, signal: AbortSignal): Promise<{ job: MigrationJob; created: boolean } | undefined> {
  if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
  const id = `import-${++serial}`;
  const cancel = () => { void importer.cancel({ id }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let token: string | undefined;
  try {
    const selected = await importer.select({ generation, id });
    token = selected.token;
    if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
    if (selected.cancelled) return;
    if (!token || !selected.name) throw new Error('Missing OS import grant');
    return await request<{ job: MigrationJob; created: boolean }>('/api/migration/jobs', { method: 'POST', body: nativeImportBody(token), signal, timeoutMs: 120000 });
  } finally {
    signal.removeEventListener('abort', cancel);
    if (token) await importer.release({ token }).catch(() => {});
  }
}
