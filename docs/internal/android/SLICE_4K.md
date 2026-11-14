# S4k — Exhaustion and cancellation of the publisher in background

The test adopts an existing room through resume409, plays local music
through the service and closes the Activity. The fixture rejects only the
publishing credential of the selected stream and cuts its real publisher.
Android makes three reconnection attempts, removes Live when they are exhausted and leaves
local playback and the queue occurrence intact. It does not keep retrying.

Removing the rejection and pressing Go live publishes again in the same room. A second
cut reaches one rejected attempt; logging out cancels the pending retries,
removes the host session and leaves no publisher in MediaMTX. Five
seconds without new authorizations are observed. The test authenticates again only to
delete its isolated room with a signed authorization.

The fixture intervention distinguishes reading and publishing. It does not modify the
production policy or simulate the service, the socket or the media transport.
The HTTP/TLS acceptance and the normal checks are recorded in evidence/s4k.json.
It does not demonstrate cancellation of an initial room creation POST, physical acoustic
acceptance or a full main/browser regression.
