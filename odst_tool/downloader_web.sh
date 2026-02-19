#!/bin/bash
# ODST Tool - Web-based music downloader
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PARENT_DIR="$(dirname "$DIR")"

# Use parent project's venv
source "$PARENT_DIR/venv/bin/activate"

# Run as module from parent directory to support relative imports
cd "$PARENT_DIR"
python -m odst_tool.web_app
