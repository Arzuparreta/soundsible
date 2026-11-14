# S5e: car controls during DJ

CarDjTest2/0 HTTP/TLS; runner exit0 and APK/test APK/JVM54/lint without temporary CA.
[evidence](evidence/s5e.json) records revision, hash and duration.

Core creates the DJ programme with two real decoders. The modern and classic browsers
observe the dominant song. Browse keeps the token and occurrence keys;
pause/seek6000ms from classic, resume from modern, and the reverse sequence
keep DJ and produce non-silent stereo 48k PCM.

The first block failed because of an incorrect check in the test: source indicates
the file type, not DJ mode. It was corrected with independent assertions of mode,
token/keys and PCM. It was not a product failure.

SameUID/AVD does not test the Google Auto host, an external UID, physical audio or full
parity. Labels of the active programme and loss/reconnection are still pending.
