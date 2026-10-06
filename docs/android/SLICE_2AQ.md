# S2aq — Reconexión de dispositivo tras agotar Socket.IO

The service's socket manager retries five times. Once those attempts exhaust,
NativeDeviceSession retires that manager and its transport, applies30s cooldown
and verifies the current cookie/profile before a new connection. The stable
origin/account device UUID survives; native playback is independent of this
socket. Reset removes manager listeners as well as socket listeners, preventing
retired reconnect callbacks from registering another account or waking old work.

DeviceReconnectTest uses a real Core Socket.IO transport failure, not a synthetic
disconnect event. Activity stays closed, a20s PCM fixture repeats through the
outage, retries exhaust into cooldown, transport returns, the same device
registers and republishes, and remote pause/resume again delivers native PCM.
HTTP/TLS2/0; runner exit0 and normal APK/test APK/JVM56/lint without fixture CA.
Log `/tmp/soundsible-device-reconnect-final-native.log`. Initial test never reached
the outage: fixture-only paths must use the raw test client because production
EngineConnection.execute correctly accepts only /api paths; corrected accordingly.

No physical network/car claim. Core publication is eventually refreshed after
reconnect; completed offline copies remain untouched. Deferred catalog and final
whole-suite coverage still need completion.
