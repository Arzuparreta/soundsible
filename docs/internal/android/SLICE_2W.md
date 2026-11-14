# S2w: timed lyrics with the native program

The web LyricsPanel becomes an adapter of the shared LyricsPanelView, with current
track/time, library/saved identity and seek injected. Android uses the same panel
without importing web stores or audio. It opens from Show lyrics in the three-dot
menu of the program; podcasts do not offer lyrics. Window with its own scroller,
line following and seek through IPC; closing does not change pause/queue/position.

The existing queries /api/library/tracks/<id>/lyrics and /api/lyrics keep their
contract; they accept AbortSignal. The panel cancels query/polling when the song changes,
when there is no song left or on unmount. Android closes it when switching account or closing the
program. A memo of native metadata avoids querying again as the position advances.
The current line exposes aria-current in addition to its visual highlight.

Complete UI **1,419 tests/164 files passes**, /tmp/soundsible-s2w-ui-preview.log:
previous web, native position without refetch, seek to the runtime and account switch aborts the
pending query. Android assets prepared from the working tree since 9bc041d;
not a clean release artifact. The fixture caches synthetic lyrics per track/user
using the real database; it does not depend on live LRCLIB and does not simulate bridge responses.

APK **two HTTP/HTTPS cases pass**, zero failures/skipped,
/tmp/soundsible-s2w-native-preview.log: search lyrics of an acquired track, tap the line at 20s,
check authoritative position/highlight, pause/keys/queueToken kept,
without HTMLAudio, close the window and Sign out without the previous panel/program.
A saved preview uses metadata (not the library ID), respects sourceKind unverified and
shows plain text without timed lines; both protocols accepted. Real engine
cache; live LRCLIB provider and physical combinations not validated. Final sources
prepared from 9bc041d with dirty=true. Normal APK/test/unit/lint without CA passes when the helper finishes.

The complete matrix continues: library/Discover/acquisition/import/Settings,
sharing/deeplinks/multi-device, DJ/Live/Auto, signing/update/publishing. Browser
four profiles and extended main regression before the final PR.
