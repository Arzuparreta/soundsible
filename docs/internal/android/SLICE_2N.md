# S2n: favourites and playlist membership

Favourites are confirmed on the server, appear in the shared row and have a
library view. The menu keeps intent and account. PUT favourites receives
entry plus boolean marked; repeating the request does not invert the state. Unmark of an
entry deleted by another client does not save it again. The existing toggle
endpoint keeps its contract. Library write permissions/roles are respected.

The playlist selector shares styles and texts, keeps the selected file or preview
and shows a failure without closing. Creating, saving preview identity and adding
membership require a real response. A preview is saved explicitly, without
acquiring audio; the engine accepts membership by ID and the identity stays resolvable.
It only closes after confirming the ID in the playlist and refreshing Library. An account
change aborts the request and closes selector and prompt; late callbacks do not migrate.

The UI uses existing rows/virtualization without importing web audio stores.
Offline does not allow remote mutations; keep the Offline B limits. Full
playlist management (rename/delete/order/cover/remove), metadata, entities,
acquisition/import and the rest of the matrix remain pending.

Unit and route evidence in HANDOFF. The APK must confirm HTTP/HTTPS,
favourite → filter → unmark keeping the file, create playlist and real
membership, absence of HTML audio and isolation/cancellation. Do not consider the flow
accepted because it compiles or because of a UI mock.
