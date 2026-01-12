from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
import os
import threading
from pathlib import Path
from rich.console import Console

from shared.models import PlayerConfig, StorageProvider
from shared.constants import DEFAULT_CONFIG_DIR
from .uploader import UploadEngine
from rich.progress import Progress

app = Flask(__name__)
app.config['SECRET_KEY'] = os.urandom(24)
socketio = SocketIO(app, cors_allowed_origins="*")
console = Console()

# Global config cache
current_config = None

def load_config():
    global current_config
    try:
        config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
        if config_path.exists():
            with open(config_path, 'r') as f:
                import json
                data = json.load(f)
                current_config = PlayerConfig.from_dict(data)
                return True
    except Exception as e:
        console.print(f"[red]Error loading config: {e}[/red]")
    return False

@app.route('/')
def index():
    config_loaded = load_config()
    return render_template('index.html', config_loaded=config_loaded, config=current_config)

@socketio.on('connect')
def handle_connect():
    emit('status', {'msg': 'Connected to Setup Tool Server'})

@socketio.on('start_upload')
def handle_upload(data):
    """Handle upload request from frontend."""
    source_path = data.get('path')
    if not source_path or not os.path.exists(source_path):
        emit('upload_error', {'msg': 'Invalid directory path'})
        return

    if not current_config:
         emit('upload_error', {'msg': 'Configuration not loaded'})
         return

    # Run upload in background thread
    threading.Thread(target=run_upload_process, args=(source_path,)).start()
    emit('upload_started', {'path': source_path})

def run_upload_process(path):
    """Background upload process that emits events."""
    try:
        uploader = UploadEngine(current_config)
        
        # Custom progress class to bridge Rich Progress -> SocketIO
        # We can't easily pass the rich progress object, so we'll 
        # modify UploadEngine or wrap it. 
        # For MVP, let's create a proxy progress reporter.
        
        # We need to adapt UploadEngine to report progress via callback or similar.
        # Since UploadEngine currently expects a rich.progress.Progress object, 
        # let's mock it or adapt it.
        
        class SocketProgress:
            def __init__(self, socket):
                self.socket = socket
                self.tasks = {}
                
            def add_task(self, description, total=None):
                task_id = str(len(self.tasks))
                self.tasks[task_id] = {'desc': description, 'total': total, 'completed': 0}
                self.socket.emit('progress_update', {
                    'task_id': task_id,
                    'description': description,
                    'total': total,
                    'completed': 0
                })
                return task_id
                
            def update(self, task_id, completed=None, description=None, visible=None, total=None):
                if task_id in self.tasks:
                    if completed is not None: self.tasks[task_id]['completed'] = completed
                    if total is not None: self.tasks[task_id]['total'] = total
                    
                    self.socket.emit('progress_update', {
                        'task_id': task_id,
                        'completed': self.tasks[task_id]['completed'],
                        'total': self.tasks[task_id]['total']
                    })
            
            def advance(self, task_id, advance=1):
                if task_id in self.tasks:
                    self.tasks[task_id]['completed'] += advance
                    self.socket.emit('progress_update', {
                        'task_id': task_id,
                        'completed': self.tasks[task_id]['completed']
                    })

        # Note: UploadEngine type hint assumes rich.progress.Progress, but python makes it duck-typeable.
        proxy_progress = SocketProgress(socketio)
        
        library = uploader.run(path, progress=proxy_progress)
        
        socketio.emit('upload_complete', {
            'tracks': len(library.tracks) if library else 0
        })
        
    except Exception as e:
        socketio.emit('upload_error', {'msg': str(e)})

def start_server(debug=False, port=5000):
    load_config()
    socketio.run(app, debug=debug, port=port)
