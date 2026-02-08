from .main import MusicApp

def run():
    app = MusicApp(application_id="com.soundsible.player")
    import sys
    app.run(sys.argv)
