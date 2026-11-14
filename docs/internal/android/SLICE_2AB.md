# S2ab: removal during a pending Radio/autoplay response

Continuation of S2aa implemented and validated on emulator API36. It does not change
the offline decision or close full parity.

Add to the isolated fixture a control authorized only by loopback + header
to delay a single response already computed by the real planner. Do not replace
its body, selection or Core read. The control exposes only bounded local IDs
and pending/delivered counters; maximum delay five seconds, reset after
each case, no cookies or personal metadata in logs. Test that a call without
authorization cannot control the delay.

With synthetic acquired music from the fixture, pause the programme at 20s, enable Radio
or autoplay and wait until the planner has produced candidates. Remove through the UI
a local candidate while its response is pending. Verify a private snapshot
without the file, effective removal from the service and permanent absence of the ID
when the earlier response arrives and when a new refill completes.
Keep key/identity/pause/position of the current track and profile/mode; no old
response may open another account or close a new programme. Repeat HTTP/HTTPS and
Radio/autoplay; cleanup regenerates only its own synthetic files and restores
preferences/controls. Do not delete a personal library.

Prepare assets before instrumenting. Save the specific result and go back to
normal APK/test APK/JVM/lint without the temporary CA. Clean principal run dc29b73 (49+restart2)
in progress: do not modify the artifact of that run or confuse its sources
with this slice. Extend the regression afterwards if instrumented cases are added.

Then continue with Library/Discover/Settings, DJ, Live, Android Auto, signing/update;
PR/main/alpha only with the full gates. Do not end the turn per slice.

Fixture implemented: delay of a single real response, authorized and bounded;
GET stats exposes candidate IDs and pending/delivered. It uses cooperative gevent
sleep, like the server, so that DELETE/GET can progress while the response
is held. A blocking sleep also blocked the observation queries;
the test detected that error and the helper was corrected, without modifying the planner.
Python WAV/FLAC: two cases pass in /tmp/soundsible-s2ab-planner-fixture.log.
They verify unauthorized control/invalid values, real DELETE, old response
with the removed ID, snapshot without the ID and new plan without the ID. Ruff passes.

Instrumentation moved to
[PlannerRetirementTest.java](../../../android/app/src/androidTest/java/com/soundsible/android/PlannerRetirementTest.java)
after clean principal run dc29b73: run HTTP/HTTPS for both modes. Four instrumented HTTP/HTTPS Radio/autoplay cases pass, zero failures/errors/
skips, within targeted6 in /tmp/soundsible-s2ab-native.log. Assets from
4e04083 dirty=true. Deletion is confirmed while pending>0; old plan
delivered, new refill, absence of the local ID, key/programToken/pause at 20s and modes
preserved, without HTML audio. Cleanup restores the preference and regenerates only synthetic
music after draining the pending response. Normal APK/test APK/JVM17/lint
pass without the temporary CA. No acoustic acceptance or full parity. Next
extended principal run 53 + restart2 from a clean commit still pending.
