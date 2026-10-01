import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
function dependencies(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)]
    .filter(([, spec, path]) => path.startsWith('.') && !/^\{\s*type\b/.test(spec.trim()))
    .flatMap(([, , path]) => {
      const target = resolve(dirname(file), path);
      return [target + '.ts', target + '.tsx', resolve(target, 'index.ts')].filter(existsSync).slice(0, 1);
    });
}
function reachable(entry: string, seen = new Set<string>()): Set<string> {
  const file = resolve(root, entry);
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const dependency of dependencies(file)) reachable(dependency, seen);
  return seen;
}

describe('client module boundaries', () => {
  it.each(['main.tsx', 'stores/core.ts', 'stores/visualPreferences.ts', 'components/DisplayPreferences.tsx'])('%s does not initialize playback or sockets', entry => {
    const graph = reachable(entry);
    for (const forbidden of ['stores/index.ts', 'lib/audio.ts', 'lib/socket.ts', 'AuthenticatedPlayer.tsx']) {
      expect(graph.has(resolve(root, forbidden)), forbidden).toBe(false);
    }
  });

  it('domain controllers do not import the composition root or form runtime cycles', () => {
    const visited = new Set<string>();
    const walk = (file: string, stack: string[]) => {
      expect(stack.includes(file), stack.concat(file).join(' -> ')).toBe(false);
      if (visited.has(file)) return;
      for (const dependency of dependencies(file)) {
        expect(dependency).not.toBe(resolve(root, 'stores/index.ts'));
        walk(dependency, [...stack, file]);
      }
      visited.add(file);
    };
    for (const module of ['transport', 'dj', 'queue', 'session', 'podcasts', 'runtime', 'collection', 'playlists', 'downloadActions', 'preferences']) {
      walk(resolve(root, `stores/${module}.ts`), []);
    }
  });
});
