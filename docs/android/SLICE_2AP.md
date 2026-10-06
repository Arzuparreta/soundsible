# S2ap — Radio y runway de Autoplay en traspasos

NORMAL snapshots preserve imported queue lanes/sources/context metadata, podcast
fields, musical identity and loudness facts. Radio carries active/seedId in the
shared contract; native peers additionally retain profile and the public seed.
Receivers of the older/common contract use balanced when no profile is supplied.
Source addresses and account cookies are not part of this state.

Restoring Radio keeps its received runway rather than starting another radio and
removing those entries. Generated occurrence ownership is rebound to native keys.
Stop removes only generated future entries, keeping consumed/current history and
manual songs. Autoplay restores its generated markers/ownership and then obeys
the receiver's confirmed account preference; disabled removes only that imported
future. Continuation attached to a podcast is refused before replacing playback.

Acceptance: DeviceRadio + DeviceDj + DeviceSession + DevicesUi8/0 HTTP/TLS,
86.694s; integration exit0, normal APK/test APK/JVM56/lint without fixture CA.
Log `/tmp/soundsible-radio-device-native.log`. Radio enters native playback/PCM,
its intent/seed/profile/generated ownership leaves through real Core handoff,
Stop retains the manual song, and disabled Autoplay strips only generated future.
DJ, NORMAL and visible device controls are included as regressions.

The peer validates outgoing metadata rather than rendering sound. Radio with a
seed outside the bounded window reconstructs its public identity; new planning
still requires Core/providers. Native profile/seed extras are extensions; do not
claim that a web peer preserves them on its return. Deferred catalog entries and
long device-session reconnection still need completion. Physical acceptance and
publication remain separate gates.
