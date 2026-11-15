# Podcast artwork, 2026-11-15

Before: the live engine on `main` after #436. After: an isolated engine on the
`fix/podcast-artwork-cache` branch, following the same two feeds.

| Show | Before | After |
| --- | --- | --- |
| Nerd Snipe (Anchor) | no artwork anywhere | header and every row |
| Herrera en COPE | episode rows only, empty header | header and every row |

## Cause

`/api/podcasts/artwork` accepted a publisher's image only when its
`Content-Type` was one of `image/jpeg|png|webp|gif|avif`.

| Host | Image | `Content-Type` sent |
| --- | --- | --- |
| `d3t3ozftmdmh3i.cloudfront.net` (Anchor / Spotify for Creators) | every show and episode | `image/jpg` |
| `imagenes.cope.es` | COPE show artwork (`uploads/…/original_*.jpeg`) | `application/octet-stream` |
| `imagenes.cope.es` | COPE episode artwork (`files/image_984_984/…`) | `image/jpeg` |

Both refused labels answered 404, and the page drew the empty placeholder.

## Bytes per cover, after

Measured on the endpoint with the real hosts (`shared.podcast_artwork`, first
request fetches from the publisher, later sizes come from the cached master):

| Image | Publisher | Row (160) | Header (320) | Card (640) |
| --- | --- | --- | --- | --- |
| Anchor, Nerd Snipe | 936 KB | 3 KB | 10 KB | 27 KB |
| COPE show | 678 KB | 10 KB | 30 KB | 90 KB |
| COPE episode | 918 KB | 8 KB | 25 KB | 81 KB |
| esRadio, Federico | 412 KB | 7 KB | 18 KB | 46 KB |
| Lex Fridman (3000 px) | 2040 KB | 6 KB | 17 KB | 58 KB |

Before, a row received what the old endpoint passed through: up to 1024 px and
1 MB (the COPE episode image, 918 KB, for a 44 px row).

First request for an image: 160–1140 ms (publisher fetch plus master draw).
Any other size of it afterwards: 10–25 ms. Twenty concurrent requests for four
images in four sizes, under gevent with the image worker: four publisher
fetches, 1.15 s in total.
