"""Render two original short instrumental loops using only the standard library."""
import array
import json
import math
from pathlib import Path
import sys
import wave

out = Path(sys.argv[1])
rate = 22050
catalog = []
for name, notes in [
    ("Late Platform", [60, 67, 71, 74, 69, 64, 67, 62]),
    ("Glass Steps", [62, 65, 69, 72, 67, 70, 65, 69]),
]:
    slug = name.lower().replace(" ", "-")
    samples = array.array("h")
    for bar in range(4):
        for pitch in notes:
            hz = 440 * 2 ** ((pitch - 69 + [0, -5, -2, 0][bar]) / 12)
            for i in range(rate // 2):
                t = i / rate
                envelope = min(1, t * 90, (0.5 - t) * 25) * math.exp(-4 * t)
                tone = math.sin(math.tau * hz * t) + 0.3 * math.sin(math.pi * hz * t)
                samples.append(round(12000 * envelope * tone))
    if sys.byteorder != "little":
        samples.byteswap()
    with wave.open(str(out / (slug + ".wav")), "wb") as recording:
        recording.setparams((1, 2, rate, 0, "NONE", ""))
        recording.writeframes(samples.tobytes())
    catalog.append(dict(id=slug, title=name, artist="Soundsible", album="Station Studies",
                        album_artist="Soundsible", duration=len(samples) / rate, genre="Electronic"))
(out / "catalog.json").write_text(json.dumps(catalog))
