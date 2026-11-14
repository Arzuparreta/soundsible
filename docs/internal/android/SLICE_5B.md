# S5b: Android Auto subscriptions in the background

**8/0 HTTP/TLS,50.108s**, runner exit0: CarEvents2 + CarLibrary2 + CarLegacy2 +
TransportReset2. APK/test APK/JVM54/lint pass without temporary CA.
[evidence](evidence/s5b.json) keeps hashes and the revocation diagnosis.

ProgramCarSubscriptions opens native Socket.IO only when there are car
subscribers. Connection/cookie and callbacks are bound to generation/identity. Core events
library/saved/favourites and the initial connection group refreshes during250ms; the
current profile metadata is queried before notifyChildrenChanged. There are at most64 registrations
and16 distinct parents. A parent in flight is marked dirty and only that parent
is repeated: a slow fetch does not create a polling loop over all folders.
Unsubscription/disconnection removes registrations; the last one closes the socket and cancels
work. Reset/logout/destroy invalidate callbacks and resources. Reconnection configured
with5 bounded attempts; real network loss/reconnect not yet tested.

CarEventsTest destroys Activity/WebView with real music playing. It changes
labels and creates/deletes a playlist through the Core API; the browser receives events/children and
updated counts. It keeps KEY and PCM. After unsubscribe, another mutation does not
notify. HTTP and TLS, without real engine/accounts.

With the new subscription there was a401 race: a background browse could
revoke the session before the explicit browse. Now all pending futures
receive expired authentication when401 is the cause; reset due to disconnection keeps
its reason. The initial identity guard tolerates a changed generation without throwing an exception
from the callback. The earlier modern/classic block passes together with the events.

Pending: real loss/reconnection, local offline storage events,
Auto with expired cookie without observed401, controls/metadata during DJ and external
UID/host. Updating children does not prove refresh of labels of the program
that is already playing. It is not full parity or car/physical listening acceptance.
