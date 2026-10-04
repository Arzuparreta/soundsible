/** Shared bookmark identity without stores, navigation or audio runtime. */
export interface SavedEntity {
  kind: 'artist' | 'album';
  name: string;
  artist?: string;
  cover?: string;
  destination: string;
  keys?: string[];
  id?: string;
  added_at?: string;
}

export function entityKeys(entry: SavedEntity): string[] {
  const params = new URLSearchParams(entry.destination.split('?')[1]);
  const keys = [...(entry.keys ?? [])];
  for (const [param, namespace] of [[`${entry.kind}_id`, 'library'], ['deezer_id', 'deezer']]) {
    const id = params.get(param);
    if (id) keys.push(`${entry.kind}:${namespace}:${id}`);
  }
  return keys.filter((key) => !key.includes(':reference:'));
}

export function sameEntity(a: SavedEntity, b: SavedEntity): boolean {
  if (a.kind !== b.kind) return false;
  const ak = entityKeys(a), bk = entityKeys(b);
  if (ak.length || bk.length) return ak.some((key) => bk.includes(key));
  return a.name === b.name && (a.artist ?? '') === (b.artist ?? '');
}

