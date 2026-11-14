# S2u: system cover picker

S2r/S2s test real multipart with a synthetic File. S2u adds selection through
the OS picker, reading of the content URI granted by the system and cancellation.

Test implementation: [CoverPickerTest.java](../../../android/app/src/androidTest/java/com/soundsible/android/CoverPickerTest.java).
Emulator API 36, real HTTP/HTTPS engines, physical tap on Upload cover,
Back and check that the editor is kept/cover unchanged. The test seeds
a green PNG with a magenta border in MediaStore and taps its thumbnail identified
by that pattern. It does not use File/DataTransfer or simulate ActivityResult.

Photo Picker does not expose the file name and darkens/resamples thumbnails.
The detection allows that brightness change, requires a magenta border on all four
sides and rejects ambiguous patterns. The later check of the uploaded private
bitmap requires the original color, independently of the appearance of the thumbnail.
Teardown restores the original cover and deletes only the seeded PNG.

No broad storage/camera permissions: existing system contract
with per-file grant. The emulator is not equivalent to all provider apps,
Android versions or physical manufacturers. Account/editor guards are kept.

Status: **two HTTP/HTTPS tests pass**, zero failures/skipped on API 36,
`/tmp/soundsible-s2u-native-stable.log`. The normal rebuild found only
UseSdkSuppress in the test; fixed to @SdkSuppress(minSdkVersion=29), normal APK/test/unit/lint without CA passes in `/tmp/soundsible-s2u-normal.log`. The logic of the accepted case was not changed.
UI sources prepared from clean cf01599; S2u instrumentation during development.
Previous main regression: S2t35 plus two restart phases pass from clean cf01599.
Full parity, final browser, DJ/Live/Auto and signing/update are still pending.
Do not publish a partial alpha or close work per slice.
