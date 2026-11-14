# S2ao — Workspace DJ multidispositivo

Core handoff now marks start events as handoffs. A transport resume reuses native
occurrences; a genuine handoff rebuilds the received workspace even if its queue
IDs match the paused local queue. This prevents losing direction/source edits made
on another device while it held that same queue. Other clients ignore the optional
marker and keep their existing state/track contract.

The shared auto session restores a bounded route, current index/position, technical
DJ profile, direction, explicit source policy, source trays, heard/avoided identities,
exploration and transition proposals. Native occurrence keys remap bridge ownership;
transition fromKey uses the shared musical identity on the wire and the actual
preceding occurrence inside the native engine. Public plan/source labels and route
metadata are retained. Native queue facts carry programme loudness into DSP.

A restored planner retains workspace exclusions/exploration for later requests;
a fresh START clears the previous restored envelope. The dual-decoder session can
start at a restored index with history instead of dropping everything before it.
Remote resume keeps the current native programme; genuine handoff goes through the
same native install path as a planned start. Invalid profiles/queues/bridge ownership
are rejected before replacing playback. Unresolved catalog entries remain pending.

Acceptance: Core16/0; DeviceDj + DeviceSession + DevicesUi6/0 HTTP/TLS,51.706s;
integration exit0 and normal APK/test APK/JVM56/lint without fixture CA. Log
`/tmp/soundsible-dj-device-final-native.log`. Native DJ incoming/outgoing, PCM,
Activity-closed pause/play/seek/next/previous, duplicate keys, source/direction/plan/
bridge ownership, a returned same-queue direction edit and malformed profile refusal
are validated. NORMAL and visible device-control regressions are included.

The peer checks the outgoing socket contract, not acoustic output. The validated
route has resolved local music and one planned transition; not every musical
transition/source combination is represented. Radio, pending catalog resolution,
reconnect exhaustion and broader DJ negatives still need gates. NORMAL tests now
seek within short synthetic tracks to remain independent of earlier PCM fixtures;
previous long-position evidence remains recorded in its earlier slices.
