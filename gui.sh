#!/bin/bash
# Convenience script to start the GUI Player
cd "$(dirname "$0")"

if [ -f "venv/bin/python" ]; then
    PYTHON="venv/bin/python"
elif [ -f "venv/Scripts/python.exe" ]; then
    PYTHON="venv/Scripts/python.exe"
else
    echo "❌ Error: Virtual environment not found."
    exit 1
fi

echo "🚀 Starting Music Hub GUI..."
# We run the ui module directly
exec "$PYTHON" -c "from player.ui import run; run()"
