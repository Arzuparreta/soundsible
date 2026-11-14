# S2v: edited artwork versus embedded artwork

The installed Media3 BitmapLoader prioritizes artworkData over artworkUri.
The new tag/sidecar endpoints keep the audio file intact;
therefore a FLAC with its original embedded cover can hide the edit in the
media session/notification even though the library shows the new sidecar.

ProgramArtwork override loadBitmapFromMetadata gives priority to private
soundsible-artwork URIs. It reuses authenticated transport, generation guards and a bounded
cache; an expired private URI fails without recovering old embedded bytes.
Metadata without a private URI keeps the embedded image behavior and without
an image returns null. Music is not rewritten to change a cover.

Instrumented acceptance:
- ArtworkTest: red private URI with blue embedded shows red; without URI keeps
  blue; without both returns null; logout invalidates the private URI even if bytes remain.
- MetadataTest: real FLAC with an embedded red cover, check those original bytes with MediaMetadataRetriever
  on a bounded temporary copy of the authenticated FLAC; edit to green through multipart, require green also in the
  system media session and keep audio SHA-256/ID/queue/position/copies.
- HTTP and HTTPS with temporary CA, then normal APK/test/unit/lint without CA.

The optional FLAC fixture now carries embedded artwork through a real AudioProcessor.
The Radio fixture copies files according to the real format, with Python WAV and
FLAC regression, so as not to promise FLAC support while leaving hardcoded .wav paths.

The merged metadata delivered by MediaController can omit artworkData
when the app provides a URI. Do not assume it reflects all the tags of the file;
check the encoded file and the system session separately. The first attempt
failed because of that assumption; it is not declared accepted.

Status: **four HTTP/HTTPS cases pass**, zero failures/skipped, FLAC with embedded
image and real media session on API 36. Log /tmp/soundsible-s2v-embedded-source.log;
normal APK/test/unit/lint without CA passes when the helper finishes. Python Radio WAV/FLAC
**two tests pass**, /tmp/soundsible-s2v-radio-fixture.log. Do not extrapolate to physical
listening or all formats/decoders. UI sources
prepared from cf01599; instrumentation/service changed in the working tree.
It does not change the alpha gates: the rest of parity, DJ/Live/Auto and signing/update pending.
