// Build the release's regular player with browser-local services.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../ui_web/package.json', import.meta.url));
const { build } = await import(pathToFileURL(require.resolve('vite')));
const source = fileURLToPath(new URL('../../ui_web/src/', import.meta.url));
const transport = fileURLToPath(new URL('./transport.js', import.meta.url));
const from = path => JSON.stringify(source + path);
const shim = path => `export * from ${from(path)};`;
const localNavigation = ['/', '/search', '/favourites', '/library?view=songs', '/library?view=albums', '/library?view=artists'];
const overrides = new Map(Object.entries({
  'lib/media.ts': `
    ${shim('lib/media.ts')}
    import { coverUrl } from ${JSON.stringify(transport)};
    export { streamUrl, coverUrl } from ${JSON.stringify(transport)};
    export const trackCoverUrl = track => coverUrl(track.id);
    export const hasCoverArt = track => !!coverUrl(track.id);
  `,
  'lib/i18n.tsx': `
    ${shim('lib/i18n.tsx')}
    import { locale, t as translate } from ${from('lib/i18n.tsx')};
    const copy = {
      'nav.search': { en: 'Search', es: 'Buscar' },
      'search.placeholder': { en: 'Search the demo library', es: 'Buscar en la biblioteca de la demo' },
    };
    export const t = (key, params) => copy[key]?.[locale()] ?? translate(key, params);
  `,
  'lib/pwa.ts': 'export function registerServiceWorker() {}',
  'lib/socket.ts': `
    export function createSocket() {
      const socket = {
        connected: false,
        on: () => socket, off: () => socket, emit: () => socket,
        connect: () => socket, disconnect: () => socket,
      };
      return socket;
    }
  `,
  'components/primaryNavigation.tsx': `
    ${shim('components/primaryNavigation.tsx')}
    import * as original from ${from('components/primaryNavigation.tsx')};
    const enabled = new Set(${JSON.stringify(localNavigation)});
    const keep = items => items.filter(item => enabled.has(item.href));
    export const primaryNavigation = keep(original.primaryNavigation);
    export const libraryShortcuts = keep(original.libraryShortcuts);
    export const libraryViews = keep(original.libraryViews);
    export const navigationItems = keep(original.navigationItems);
    export const defaultBottomNavigation = ['/', '/search', '/favourites'];
    export const navigationGroups = original.navigationGroups
      .map(group => ({ ...group, hrefs: group.hrefs.filter(href => enabled.has(href)) }))
      .filter(group => group.hrefs.length);
  `,
  'components/trackActions.tsx': `
    ${shim('components/trackActions.tsx')}
    import { buildTrackMenu as original } from ${from('components/trackActions.tsx')};
    import { openContextMenu } from ${from('lib/contextMenu.tsx')};
    import { t } from ${from('lib/i18n.tsx')};
    export function buildTrackMenu(track, context) {
      const allowed = new Set([
        t('trackActions.playNext'), t('trackActions.addToQueue'),
        t('trackActions.goToArtist'), t('musicExplorer.openAlbum'),
        t('trackActions.addFav'), t('trackActions.removeFav'),
      ]);
      return original(track, context).filter(action => allowed.has(action.label));
    }
    export function trackMenuOptions(track, context) {
      return { title: track.title, subtitle: track.artist, actions: buildTrackMenu(track, context) };
    }
    export function openTrackMenu(track, context, event) {
      openContextMenu(trackMenuOptions(track, context), event);
    }
  `,
  'components/CollectionActions.tsx': 'export const CollectionActions = () => null;',
  'components/EntityViewSelect.tsx': 'export const EntityViewSelect = () => null;',
  'components/CollectionControl.tsx': `
    ${shim('components/CollectionControl.tsx')}
    export const EntityBookmarkButton = () => null;
  `,
  'components/SearchDiscovery.tsx': 'export const SearchDiscovery = () => null;',
}));
const overrideNames = new Set([...overrides.keys()].map(path => path.split('/').at(-1).replace(/\.tsx?$/, '')));
await build({
  base: './',
  build: { outDir: process.argv[2] },
  plugins: [{
    name: 'static-demo-services',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!importer || importer.startsWith('\0') || !overrideNames.has(id.split('/').at(-1))) return;
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      const relative = resolved?.id.startsWith(source) ? resolved.id.slice(source.length) : '';
      if (overrides.has(relative)) return '\0demo:' + relative;
    },
    load(id) {
      if (id.startsWith('\0demo:')) return overrides.get(id.slice('\0demo:'.length));
    },
    transform(code, id) {
      if (id === source + 'main.tsx') {
        return `import { setRequestTransport } from './lib/http';
          import { setLocale } from './lib/i18n';
          import { demoRequest } from ${JSON.stringify(transport)};
          setRequestTransport(demoRequest);
          const demoLanguage = new URLSearchParams(location.search).get('lang');
          if (demoLanguage === 'en' || demoLanguage === 'es') void setLocale(demoLanguage);
          ` + code;
      }
    },
  }],
});
