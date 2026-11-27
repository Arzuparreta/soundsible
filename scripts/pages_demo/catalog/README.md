# Demo recordings

The selected recordings are redistributed under the individual Creative Commons Attribution licenses recorded in `tracks.json`. Its source links identify the exact recordings and license pages. Original album covers are replaced by artwork created for the demo.

The bundled files contain complete recordings transcoded from the linked original Ogg files, without edits to the music. To reproduce the encoding use `ffmpeg -i original.ogg -map_metadata -1 -vn -c:a libmp3lame -b:a 96k output.mp3`. Confirm the license on the file page before replacing a recording and update its duration and SHA-256. The build validates those recorded hashes and emits the public credits. Release and Pages builds use the checked-in media and require no third-party audio downloads.
