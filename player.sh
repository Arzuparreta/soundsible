#!/bin/bash
# Convenience script to start the Music Player
# Automatically uses the virtual environment

# Ensure we are in the project directory
cd "$(dirname "$0")"

# Locate the virtual environment python
if [ -f "venv/bin/python" ]; then
    PYTHON="venv/bin/python"
elif [ -f "venv/Scripts/python.exe" ]; then
    PYTHON="venv/Scripts/python.exe"
else
    echo "❌ Error: Virtual environment not found in ./venv"
    echo "Please run setup first: python -m setup_tool init"
    exit 1
fi

# Execute the player module using the venv python
# "$@" passes any arguments (like 'list', 'play', 'download') through
exec "$PYTHON" -m player "$@"
