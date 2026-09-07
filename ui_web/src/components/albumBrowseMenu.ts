import { openActionMenu } from './ActionMenu';
import { albumSort, albumFilter, setAlbumSort, setAlbumFilter } from '../lib/libraryView';
import { ALBUM_SORTS, NO_ALBUM_FILTER } from '../lib/albumBrowse';
import { state } from '../stores';
import { t } from '../lib/i18n';

export function openAlbumBrowseMenu() {
    const active = albumFilter();
    const tick = (on: boolean) => (on ? '✓  ' : '');
    openActionMenu({
      sections: [
        {
          label: t('library.albumSortTitle'),
          actions: ALBUM_SORTS.map((sort) => ({
            label: `${tick(albumSort() === sort)}${t(`library.albumSort.${sort}`)}`,
            onSelect: () => setAlbumSort(sort),
          })),
        },
        {
          label: t('library.albumFilterTitle'),
          actions: [
            {
              label: `${tick(active.kind === 'none')}${t('library.albumFilterAll')}`,
              onSelect: () => setAlbumFilter(NO_ALBUM_FILTER),
            },
            {
              label: t('library.albumFilterByGenre'),
              disabled: state.catalog.genres.length === 0,
              onSelect: () =>
                openActionMenu({
                  title: t('library.albumFilterByGenre'),
                  actions: state.catalog.genres.map((genre) => ({
                    label: `${tick(active.kind === 'genre' && active.value === genre.name)}${genre.name}`,
                    onSelect: () => setAlbumFilter({ kind: 'genre', value: genre.name }),
                  })),
                }),
            },
            {
              label: t('library.albumFilterByYear'),
              disabled: state.catalog.years.length === 0,
              onSelect: () =>
                openActionMenu({
                  title: t('library.albumFilterByYear'),
                  actions: state.catalog.years.map((year) => ({
                    label: `${tick(active.kind === 'year' && active.value === year.year)}${year.year}`,
                    onSelect: () => setAlbumFilter({ kind: 'year', value: year.year }),
                  })),
                }),
            },
          ],
        },
      ],
    });
  }
