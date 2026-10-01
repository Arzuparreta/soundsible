"""Isolated payload benchmark fixture; never starts an engine or writes account data."""
import argparse
from pathlib import Path
from flask import Flask, jsonify, request, send_from_directory
from shared.ui_assets import serve_ui_asset

parser = argparse.ArgumentParser()
parser.add_argument("--dist", required=True)
parser.add_argument("--port", type=int, required=True)
args = parser.parse_args()
root = str(Path(args.dist).resolve())
app = Flask(__name__)

@app.route('/api/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE'])
def api(path):
    if path == 'auth/state':
        return jsonify(requires_login=request.cookies.get('payload_auth') != '1', user=None)
    if path == 'library':
        return jsonify(tracks=[], playlists={}, settings={}, podcast_subscriptions=[])
    if path == 'library/favourites':
        return jsonify([])
    if path == 'downloader/queue':
        return jsonify(queue=[], logs=[])
    return jsonify({})

@app.route('/socket.io/')
def socket():
    return '', 503

@app.route('/player/branding/<path:filename>')
def branding(filename):
    return send_from_directory(str(Path(__file__).resolve().parents[2] / 'branding'), filename)

@app.route('/player/')
@app.route('/player/<path:filename>')
def asset(filename='index.html'):
    response = serve_ui_asset(root, filename)
    response.headers['Cache-Control'] = 'no-store' if filename == 'index.html' else 'public, max-age=31536000, immutable'
    return response

app.run(host='127.0.0.1', port=args.port, threaded=True)
