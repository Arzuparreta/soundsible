#!/usr/bin/env node
/**
 * Rebuild the showcase's music from Jamendo.
 *
 * The screenshots in the README and on the site show a real-looking library,
 * and a real library is someone's music. Everything here is released under
 * CC BY, which lets the covers, titles and lyrics sit in an MIT repository and
 * in screenshots of it as long as the artists are credited — CREDITS.md, which
 * this writes alongside. A track under any other licence is refused rather
 * than skipped quietly: a curated album that changes licence should stop the
 * refresh, not thin out.
 *
 * Run only to change the selection; the output is committed and the
 * screenshots never touch the network. Needs a Jamendo API client id
 * (https://devportal.jamendo.com):
 *
 *   JAMENDO_CLIENT_ID=… node showcase/catalog/fetch.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientId = process.env.JAMENDO_CLIENT_ID;
if (!clientId) throw new Error('Set JAMENDO_CLIENT_ID to a Jamendo API client id.');

/** Who the search screenshot looks up: their photo is fetched for the top
 * result, and every album of theirs below is there for the results grid. */
const SEARCHED = 'Josh Woodward';

/** `library` is how many of an album's tracks the demo library holds; the
 * rest only turn up in search. Order is the order albums appear in "recently
 * added". `title` replaces a Jamendo album name that repeats the artist's. */
const ALBUMS = [
  { id: '79549', library: 6 }, // Josh Woodward — Ashes
  { id: '157549', library: 3 }, // Neon NiteClub — Her
  { id: '130349', library: 1 }, // Lilly Wolf — Play Loud
  { id: '2843', library: 4 }, // Zeropage — Ambient Pills
  { id: '176504', library: 2, title: 'Polygondwanaland' }, // King Gizzard & The Lizard Wizard
  { id: '171313', library: 2 }, // Cortéz — Stripped - EP
  { id: '48669', library: 4 }, // K4MMERER — Leaving Paradise
  { id: '171527', library: 4 }, // Seth Power — Magnolia Soul
  { id: '23755', library: 8 }, // Josh Woodward — The Simple Life
  { id: '116036', library: 1 }, // Martin Oakson — Summer Soon EP
  { id: '25331', library: 5 }, // Jonay — The Darker The Sky Is The Brighter The Stars Shine
  { id: '176008', library: 3 }, // Saint Anyway — Two
  { id: '149318', library: 2 }, // Devon Elizabeth — Summer Suite Volume 1
  { id: '133245', library: 5 }, // Figures in Motion — Confusion Will Pass
  { id: '165619', library: 2 }, // VITNE — Make Believe
  { id: '4622', library: 5 }, // Juanitos — Exotica
  { id: '54034', library: 6 }, // Josh Woodward — Breadcrumbs
  { id: '130347', library: 1 }, // Lilly Wolf — This Painted Life
  { id: '3263', library: 5 }, // Zeropage — Ambient Pills Update
  { id: '47767', library: 4 }, // zero-project — Earth
  { id: '185256', library: 1 }, // Rxbyn — this is summer
  { id: '193761', library: 2 }, // Square a Saw — Hope
  { id: '7098', library: 6 }, // Josh Woodward — Dirty Wings
  { id: '43195', library: 0 }, // Josh Woodward — Only Whispering
  { id: '84877', library: 0 }, // Josh Woodward — Sunny Side of the Street
  { id: '135128', library: 0 }, // Josh Woodward — The Beautiful Machine
  { id: '67189', library: 0 }, // Josh Woodward — Crawford Street
  { id: '32625', library: 0 }, // Josh Woodward — Here Today
  { id: '185422', library: 0 }, // Josh Woodward — The Shade from Our Trees
];

/** Any version of CC BY, ported ones included (`by/2.5/se/`). */
const CC_BY = /^https?:\/\/creativecommons\.org\/licenses\/by\/\d\.\d\/(?:[a-z]{2}\/)?$/;

/** Some uploads repeat the artist in the title ("Martin Oakson- Summer Soon");
 * a library would not. */
const songTitle = (row) => {
  const artist = decode(row.artist_name).toLowerCase();
  const title = decode(row.name);
  return title.toLowerCase().startsWith(artist) ? title.slice(artist.length).replace(/^\s*-\s*/, '') : title;
};

const decode = (text) =>
  text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

/** Jamendo answers a burst of requests with empty, successful results, so
 * requests are spaced out and an empty answer is asked again, slower, before
 * it is believed. */
async function api(path, params) {
  const url = new URL(`https://api.jamendo.com/v3.0/${path}/`);
  for (const [key, value] of Object.entries({ client_id: clientId, format: 'json', ...params })) {
    url.searchParams.set(key, value);
  }
  for (let attempt = 1; ; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Jamendo ${path}: HTTP ${response.status}`);
    const body = await response.json();
    if (body.headers.status !== 'success') throw new Error(`Jamendo ${path}: ${body.headers.error_message}`);
    if (body.results.length || attempt === 5) return body.results;
  }
}

async function download(url, path) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}

const albumIds = ALBUMS.map((album) => album.id);
const albumRows = await api('albums', { id: albumIds.join(' '), limit: String(albumIds.length) });
const byId = new Map(albumRows.map((row) => [row.id, row]));
const missing = albumIds.filter((id) => !byId.has(id));
if (missing.length) throw new Error(`Jamendo no longer lists albums ${missing.join(', ')}`);

await rm(join(here, 'covers'), { recursive: true, force: true });
await rm(join(here, 'artists'), { recursive: true, force: true });
await mkdir(join(here, 'covers'));
await mkdir(join(here, 'artists'));

const albums = [];
const tracks = [];
for (const { id, library, title } of ALBUMS) {
  const album = byId.get(id);
  const albumTitle = title ?? decode(album.name);
  const rows = await api('tracks', { album_id: id, include: 'licenses lyrics musicinfo', limit: '100' });
  if (!rows.length) throw new Error(`${albumTitle} (${id}): Jamendo lists no tracks`);
  const refused = rows.filter((row) => !CC_BY.test(row.license_ccurl));
  if (refused.length) {
    throw new Error(`${albumTitle}: ${refused.map((row) => `${decode(row.name)} (${row.license_ccurl || 'no licence'})`).join(', ')} not CC BY`);
  }
  rows.sort((a, b) => Number(a.position) - Number(b.position));
  const year = Number(album.releasedate.slice(0, 4));
  albums.push({
    id,
    title: albumTitle,
    artist: decode(album.artist_name),
    artist_id: album.artist_id,
    year,
    track_count: rows.length,
    url: album.shareurl,
    license: rows[0].license_ccurl,
  });
  await download(`https://usercontent.jamendo.com?type=album&id=${id}&width=500`, join(here, 'covers', `${id}.jpg`));
  for (const row of rows) {
    tracks.push({
      id: `jamendo-${row.id}`,
      title: songTitle(row),
      artist: decode(row.artist_name),
      album: albumTitle,
      album_id: id,
      album_artist: decode(album.artist_name),
      track_number: Number(row.position),
      year,
      genre: row.musicinfo?.tags?.genres?.[0] ?? null,
      duration: Number(row.duration),
      in_library: rows.indexOf(row) < library,
      // Only a library track can be put on, so only one can show its lyrics.
      lyrics: (rows.indexOf(row) < library && decode(row.lyrics ?? '').replace(/<br\s*\/?>/gi, '\n')) || null,
    });
  }
  console.log(`${decode(album.artist_name)} — ${albumTitle}: ${rows.length} tracks`);
}

const searched = albums.find((album) => album.artist === SEARCHED);
if (!searched) throw new Error(`No album by ${SEARCHED}, whom the search screenshot looks up`);
const [artist] = await api('artists', { id: searched.artist_id });
await download(`https://usercontent.jamendo.com?type=artist&id=${artist.id}&width=300`, join(here, 'artists', `${artist.id}.jpg`));
const artistList = [{ id: artist.id, name: decode(artist.name), url: artist.shareurl }];

await writeFile(join(here, 'catalog.json'), `${JSON.stringify({ albums, artists: artistList, tracks }, null, 1)}\n`);

const licenceName = (url) => {
  const [, version, port] = url.match(/by\/(\d\.\d)\/(?:([a-z]{2})\/)?/);
  return `CC BY ${version}${port ? ` ${port.toUpperCase()}` : ''}`;
};
const credits = [
  '# Music in the screenshots',
  '',
  'The library, search results and lyrics shown in the README and on the site are',
  'real releases from [Jamendo](https://www.jamendo.com), each under a Creative',
  'Commons Attribution licence. Covers are shown resized; lyric timings were added',
  'for the screenshots and are not the artists\' own.',
  '',
  '| Artist | Album | Licence |',
  '| --- | --- | --- |',
  ...[...albums]
    .sort((a, b) => a.artist.localeCompare(b.artist) || a.year - b.year)
    .map((album) => `| ${album.artist} | [${album.title}](${album.url}) (${album.year}) | [${licenceName(album.license)}](${album.license}) |`),
  '',
  'Regenerate with `JAMENDO_CLIENT_ID=… node showcase/catalog/fetch.mjs` from `ui_web/`.',
  '',
];
await writeFile(join(here, '..', 'CREDITS.md'), credits.join('\n'));
console.log(`${albums.length} albums, ${tracks.length} tracks, ${tracks.filter((t) => t.in_library).length} in the library`);
