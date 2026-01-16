#!/bin/bash
# Convenience script to start the GUI Player with auto-setup capabilities

# Ensure we are in the script's directory
cd "$(dirname "$0")"

VENV_DIR="venv"
REQUIREMENTS="requirements.txt"
MARKER_FILE="$VENV_DIR/.installed_requirements_hash"

# --- Function: Check for Python 3 ---
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: Python 3 could not be found."
    echo "   Please install Python 3 (e.g., 'sudo apt install python3' on Ubuntu/Debian)"
    exit 1
fi

# --- Function: Setup Virtual Environment ---
setup_env() {
    NEEDS_INSTALL=false

    # 1. Create venv if missing
    if [ ! -d "$VENV_DIR" ]; then
        echo "✨ First-time setup detected. Initializing..."
        echo "📦 Creating virtual environment in '$VENV_DIR'..."
        python3 -m venv "$VENV_DIR" || { echo "❌ Failed to create virtual environment."; exit 1; }
        NEEDS_INSTALL=true
    fi

    # 2. Check if requirements need updating
    if [ -f "$REQUIREMENTS" ]; then
        CURRENT_HASH=$(md5sum "$REQUIREMENTS" | cut -d ' ' -f 1)
        if [ -f "$MARKER_FILE" ]; then
            STORED_HASH=$(cat "$MARKER_FILE")
        else
            STORED_HASH=""
        fi

        if [ "$CURRENT_HASH" != "$STORED_HASH" ]; then
            NEEDS_INSTALL=true
        fi
    else
        echo "⚠️  Warning: $REQUIREMENTS not found."
    fi

    # 3. Install dependencies if needed
    if [ "$NEEDS_INSTALL" = true ]; then
        echo "⬇️  Installing/Updating dependencies from $REQUIREMENTS..."
        "$VENV_DIR/bin/pip" install --upgrade pip
        "$VENV_DIR/bin/pip" install -r "$REQUIREMENTS" || { echo "❌ Failed to install dependencies."; exit 1; }
        
        # Save the hash to avoid re-installing next time
        if [ -f "$REQUIREMENTS" ]; then
             md5sum "$REQUIREMENTS" | cut -d ' ' -f 1 > "$MARKER_FILE"
        fi
        echo "✅ Setup complete."
    fi
}

setup_env

# --- Function: Run Application ---
PYTHON="$VENV_DIR/bin/python"
echo "🚀 Starting Music Hub GUI..."

# Run the app and capture exit code
"$PYTHON" -c "from player.ui import run; run()"
EXIT_CODE=$?

# --- Function: Error Diagnostics ---
if [ $EXIT_CODE -ne 0 ]; then
    echo ""
    echo "⚠️  Application crashed (Exit Code: $EXIT_CODE)"
    
    # Check for common missing system libraries by trying to import them individually
    # We supress stderr to keep output clean, we just want the exit code
    
    if ! "$PYTHON" -c "import gi" &> /dev/null; then
        echo "❌ MISSING DEPENDENCY: GTK/PyGObject"
        echo "   Your system is missing the GTK libraries required for the GUI."
        echo "   👉 Try running: sudo apt install libcairo2-dev libgirepository1.0-dev pkg-config python3-dev"
    elif ! "$PYTHON" -c "import mpv" &> /dev/null; then
        echo "❌ MISSING DEPENDENCY: MPV"
        echo "   Your system is missing the MPV library required for playback."
        echo "   👉 Try running: sudo apt install libmpv1"
    else
        echo "   Please check the error output above for details."
    fi
    exit $EXIT_CODE
fi
