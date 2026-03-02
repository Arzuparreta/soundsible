"""GTK music player UI and application entry point."""

import sys

from .main import MusicApp


def run() -> None:
    app = MusicApp(application_id="com.soundsible.player")
    app.run(sys.argv)
