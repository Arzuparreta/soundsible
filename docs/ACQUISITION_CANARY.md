# Acquisition canary

The **Acquisition canary** GitHub Actions workflow checks whether the production
container can acquire playable audio from YouTube without cookies or a proxy.
It runs daily at 05:43 UTC, through **Run workflow**, and on pull requests that
change the canary script or workflow. It is separate from required PR checks.
Ordinary Python CI tests its behavior without contacting YouTube.

The control is Blender's public *Big Buck Bunny* upload (`YE7VzlLtp-4`), also
used in upstream yt-dlp extraction tests. The canary uses Soundsible's saved-track
downloader, including its normal native-audio and conversion fallbacks. It then
checks the file's audio stream and duration and decodes five seconds of PCM.
It does not start Soundsible, add a library track, or test preview playback.

## Run it

On Linux/macOS, with project dependencies, FFmpeg and ffprobe installed:

```sh
venv/bin/python scripts/acquisition_canary.py \
  --commit "$(git rev-parse HEAD)" --report /tmp/acquisition-canary.json
```

For the same dependency set as production, build the image and mount the script:

```sh
docker build -t soundsible-canary .
mkdir -p /tmp/soundsible-canary-reports
chmod 777 /tmp/soundsible-canary-reports
docker run --rm --init \
  --mount "type=bind,source=$PWD/scripts/acquisition_canary.py,target=/app/scripts/acquisition_canary.py,readonly" \
  --mount type=bind,source=/tmp/soundsible-canary-reports,target=/reports \
  --entrypoint python soundsible-canary \
  /app/scripts/acquisition_canary.py --commit "$(git rev-parse HEAD)" \
  --report /reports/acquisition-canary.json
```

The process returns zero only after obtaining valid audio. Each attempt has a
four-minute deadline; one fresh attempt follows a failure after 30 seconds.
The supervisor terminates the attempt's process group before removing its
temporary files. Configuration, caches and downloads are temporary; personal
cookies, proxy settings, `.env` files and yt-dlp configuration are excluded.
The explicit report destination is the only retained file.

Use `--video-id` or the manual workflow's `video_id` input to test another
public control. Supply an eleven-character ID, not a URL. If the fixed control
is removed, verify its replacement is public, has at least five seconds of
audio and is suitable for repeated downloads, then update the script default,
workflow default/fallback, this document and corresponding tests together.

## Read the result

GitHub's job summary shows pass/fail, whether a retry recovered, and each
attempt's category and duration. The JSON artifact adds the checked-out commit,
installed dependency versions, decoded-audio evidence and bounded sanitized
diagnostics. Artifacts expire after 14 days; audio is never uploaded.

A failure means **this runner could not acquire the control**. An authentication
challenge may be runner-IP blocking; an unavailable fixture may be a removed or
region-restricted upload. Neither proves that yt-dlp is broken everywhere.
Network timeouts, extraction failures, invalid audio and unknown failures stay
separate. Investigate the category and reproduce with the same image on your
server before assigning a cause. A retry recovery is visible even though the
run passes. A build/runner failure before acquisition has no audio report and
is identified separately in the summary.

Alerts use GitHub Actions and your GitHub notification settings. The workflow
does not open issues or send external messages. Failed attempts remain failures;
it never adds cookies, proxies, different extraction flags, or a dependency
upgrade to make the result green. Updating yt-dlp in installed containers is a
separate roadmap item.
