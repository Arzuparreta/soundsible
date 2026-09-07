import { createSignal } from 'solid-js';

export type BrowserSection = 'library' | 'favourites' | 'playlists' | 'root';
export type BrowserView =
  | { kind: BrowserSection }
  | { kind: 'libraryArtist'; name: string; artistId?: string }
  | { kind: 'libraryAlbum'; name: string; artist: string; albumId: string }
  | { kind: 'playlist'; name: string }
  | { kind: 'catalogArtist'; name: string; deezerId?: string }
  | { kind: 'catalogAlbum'; name: string; artist: string; deezerId?: string };
export type SearchScope = 'global' | 'library' | 'youtube';
export type ResultType = 'all' | 'songs' | 'artists' | 'albums' | 'playlists';
export interface BrowserFrame {
  view: BrowserView;
  query: string;
  scope: SearchScope;
  filter: ResultType;
  scroll: number;
}
const frame = (view: BrowserView): BrowserFrame => ({ view, query: '', scope: 'global', filter: 'all', scroll: 0 });
const initial = () => ({ library: [frame({ kind: 'library' })], favourites: [frame({ kind: 'favourites' })], playlists: [frame({ kind: 'playlists' })], root: [frame({ kind: 'root' })] });
const [sections, setSections] = createSignal(initial());
const [section, setSection] = createSignal<BrowserSection>('library');
export const musicBrowserNavigation = {
  section,
  stack: () => sections()[section()],
  current: () => sections()[section()].at(-1)!,
  update(patch: Partial<BrowserFrame>) {
    setSections((all) => ({ ...all, [section()]: [...all[section()].slice(0, -1), { ...all[section()].at(-1)!, ...patch }] }));
  },
  push(view: BrowserView) { setSections((all) => ({ ...all, [section()]: [...all[section()], frame(view)] })); },
  back() { setSections((all) => ({ ...all, [section()]: all[section()].length > 1 ? all[section()].slice(0, -1) : [frame({ kind: section() })] })); },
  select(next: BrowserSection) { setSection(next); },
  reset() { setSections(initial()); setSection('library'); },
  renamePlaylist(previous: string, next: string) {
    setSections((all) => Object.fromEntries(Object.entries(all).map(([key, frames]) => [key, frames.map((row) => row.view.kind === 'playlist' && row.view.name === previous ? { ...row, view: { kind: 'playlist', name: next } } : row)])) as ReturnType<typeof initial>);
  },
};
