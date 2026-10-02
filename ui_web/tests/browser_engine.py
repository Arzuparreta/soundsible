"""Loopback-only integration fixture for real library transactions and audio.

The test creates its own runtime and files. Authentication and unrelated
catalog/download services are fixture adapters; library commands, pagination,
Range serving and client audio/controller code are the production paths.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    root = args.directory.resolve()
    for category in ('config', 'data', 'cache', 'logs', 'music'):
        path = root / category
        path.mkdir(parents=True, exist_ok=True)
        os.environ[f'SOUNDSIBLE_{"LOG" if category == "logs" else category.upper()}_DIR'] = str(path)
    os.environ['OUTPUT_DIR'] = str(root / 'music')
    from flask import Flask, g, jsonify
    from werkzeug.serving import make_server
    from shared.runtime import RuntimeConfig, configure_runtime
    from shared.user_context import bind_user, unbind_user, user_context
    from shared import request_scope
    from shared.models import LibraryMetadata, Track
    from player.library import LibraryManager
    from shared.api.routes import library, playback
    from shared.path_resolver import path_within_roots

    configure_runtime(RuntimeConfig(host='127.0.0.1', port=0,
        config_dir=root/'config', data_dir=root/'data', cache_dir=root/'cache',
        log_dir=root/'logs', music_dir=root/'music', ui_dist=None,
        owner_token_file=None, lan_enabled=False, advanced_mode=False))
    audio = base64.b64decode((ROOT/'ui_web/tests/browser/fixtures/progressive-preview.mp3.b64').read_text())
    tracks_dir = root/'music/tracks'
    tracks_dir.mkdir()
    tracks = []
    for index in range(12):
        identifier = f'soak-{index}'
        (tracks_dir/f'{identifier}.mp3').write_bytes(audio)
        tracks.append(Track(id=identifier, title=f'Soak song {index}', artist='Fixture',
            album='Session', duration=8, file_hash=identifier,
            original_filename=f'{identifier}.mp3', compressed=False,
            file_size=len(audio), bitrate=128, format='mp3'))
    with user_context('browser-test'):
        manager = LibraryManager(silent=True)
        manager.metadata = LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={})
        if not manager._save_metadata():
            raise RuntimeError('Could not initialize isolated library')
    app = Flask(__name__)
    api = {'get_core': lambda: (manager, None, None),
           'get_track_by_id': lambda lib, identifier: lib.metadata.get_track_by_id(identifier),
           'is_trusted_network': lambda _: True,
           'is_safe_path': lambda path, **_: path_within_roots(path, [root/'music']),
           'emit_to_user': lambda *_args, **_kwargs: None}
    library._get_api = lambda: api
    playback._get_api = lambda: api
    app.register_blueprint(library.library_bp)
    app.add_url_rule('/api/static/stream/<track_id>', view_func=playback.stream_local_track)

    @app.before_request
    def begin():
        g.user_binding = bind_user('browser-test')
        g.scope_binding = request_scope.begin()
        g._soundsible_auth_context = {'kind': 'owner'}

    @app.teardown_request
    def end(_error):
        request_scope.end(g.scope_binding)
        unbind_user(g.user_binding)

    @app.route('/api/auth/state')
    def auth():
        return jsonify(requires_login=False, user={'id': 'browser-test', 'username': 'Fixture', 'role': 'admin'})

    @app.route('/api/discovery/settings')
    def settings():
        return jsonify(autoplay_enabled=False, volume_leveling=False)

    @app.route('/api/<path:path>', methods=['GET', 'POST', 'PUT'])
    def ancillary(path):
        if path == 'downloader/queue':
            return jsonify(queue=[], is_processing=False)
        return jsonify({})

    server = make_server('127.0.0.1', 0, app, threaded=True)
    print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}'}), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
