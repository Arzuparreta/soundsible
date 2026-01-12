from .main import MusicApp

def run():
    app = MusicApp(application_id="com.shmusichub.player")
    import sys
    app.run(sys.argv)
