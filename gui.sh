#!/bin/bash
# Convenience script to start the GUI Player with auto-setup capabilities

# Ensure we are in the script's directory
cd "$(dirname "$0")"

VENV_DIR="venv"
REQUIREMENTS="requirements.txt"
MARKER_FILE="$VENV_DIR/.installed_requirements_hash"

# --- Function: Check for Python 3 ---
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] Error: Python 3 could not be found."
    echo "   Please install Python 3 (e.g., 'sudo apt install python3' on Ubuntu/Debian)"
    exit 1
fi

# --- Function: Setup Virtual Environment ---
setup_env() {
    NEEDS_INSTALL=false

    # 1. Create venv if missing
    if [ ! -d "$VENV_DIR" ]; then
        echo "· First-time setup detected. Initializing..."
        echo "· Creating virtual environment in '$VENV_DIR'..."
        python3 -m venv "$VENV_DIR" || { echo "[ERROR] Failed to create virtual environment."; exit 1; }
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
        echo "⚠️[WARNING] Warning: $REQUIREMENTS not found."
    fi

    # 3. Install dependencies if needed
    if [ "$NEEDS_INSTALL" = true ]; then
        echo "⬇️[DOWNLOADING] Installing/Updating dependencies from $REQUIREMENTS..."
        "$VENV_DIR/bin/pip" install --upgrade pip
        "$VENV_DIR/bin/pip" install -r "$REQUIREMENTS" || { echo "❌ Failed to install dependencies."; exit 1; }
        
        # Save the hash to avoid re-installing next time
        if [ -f "$REQUIREMENTS" ]; then
             md5sum "$REQUIREMENTS" | cut -d ' ' -f 1 > "$MARKER_FILE"
        fi
        echo "[DONE] Setup complete."
    fi
}

setup_env

# --- Function: Detect Linux Distribution ---
detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        echo "$ID"
    else
        echo "unknown"
    fi
}

# --- Function: Install Dependencies Automatically ---
install_dependencies() {
    local dep_type="$1"
    local distro="$2"
    local packages=""
    local install_cmd=""
    
    # Determine packages and install command based on distro
    case "$distro" in
        fedora)
            case "$dep_type" in
                gtk)
                    packages="cairo-devel gobject-introspection-devel cairo-gobject-devel python3-devel pkg-config gcc"
                    ;;
                mpv)
                    packages="mpv-libs"
                    ;;
                adwaita)
                    packages="libadwaita"
                    ;;
            esac
            install_cmd="sudo dnf install -y $packages"
            ;;
        arch)
            case "$dep_type" in
                gtk)
                    packages="python-gobject gtk3"
                    ;;
                mpv)
                    packages="mpv"
                    ;;
                adwaita)
                    packages="libadwaita"
                    ;;
            esac
            install_cmd="sudo pacman -S --noconfirm $packages"
            ;;
        ubuntu|debian)
            case "$dep_type" in
                gtk)
                    packages="libcairo2-dev libgirepository1.0-dev pkg-config python3-dev"
                    ;;
                mpv)
                    packages="libmpv1"
                    ;;
                adwaita)
                    packages="gir1.2-adw-1"
                    ;;
            esac
            install_cmd="sudo apt install -y $packages"
            ;;
        *)
            return 1  # Unknown distro
            ;;
    esac
    
    if [ -z "$packages" ]; then
        return 1
    fi
    
    # Prompt user for installation
    echo ""
    echo "[?] Would you like to automatically install these dependencies?"
    echo "   Command: $install_cmd"
    read -p "   Install now? [Y/n] " -n 1 -r
    echo ""
    
    if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
        echo "⬇️  Installing dependencies..."
        if eval "$install_cmd"; then
            echo "[DONE] Dependencies installed successfully!"
            return 0
        else
            echo "[ERROR] Failed to install dependencies."
            return 1
        fi
    else
        echo "⏭️[SKIP] Skipping automatic installation."
        return 1
    fi
}

# --- Function: Run Application ---
PYTHON="$VENV_DIR/bin/python"
echo "[LAUNCHING] Starting Soundsible..."

# Run the app and capture exit code
"$PYTHON" -c "from player.ui import run; run()"
EXIT_CODE=$?

# --- Function: Error Diagnostics ---
if [ $EXIT_CODE -ne 0 ]; then
    echo ""
    echo "[WARNING] Application crashed (Exit Code: $EXIT_CODE)"
    
    # Detect the distribution
    DISTRO=$(detect_distro)
    INSTALLED=false
    
    # Check for common missing system libraries by trying to import them individually
    # We supress stderr to keep output clean, we just want the exit code
    
    if ! "$PYTHON" -c "import gi" &> /dev/null; then
        echo "[ERROR] MISSING DEPENDENCY: GTK/PyGObject"
        echo "   Your system is missing the GTK libraries required for the GUI."
        
        # Try automated installation
        if install_dependencies "gtk" "$DISTRO"; then
            INSTALLED=true
        else
            # Show manual instructions as fallback
            echo ""
            echo "   Manual installation instructions:"
            echo "   · Debian/Ubuntu: sudo apt install libcairo2-dev libgirepository1.0-dev pkg-config python3-dev"
            echo "   · Fedora:        sudo dnf install cairo-devel gobject-introspection-devel cairo-gobject-devel python3-devel pkg-config gcc"
            echo "   · Arch Linux:    sudo pacman -S python-gobject gtk3"
        fi

    elif ! "$PYTHON" -c "import mpv" &> /dev/null; then
        echo "[ERROR] MISSING DEPENDENCY: MPV"
        echo "   Your system is missing the MPV library required for playback."
        
        # Try automated installation
        if install_dependencies "mpv" "$DISTRO"; then
            INSTALLED=true
        else
            # Show manual instructions as fallback
            echo ""
            echo "   Manual installation instructions:"
            echo "   · Debian/Ubuntu: sudo apt install libmpv1"
            echo "   · Fedora:        sudo dnf install mpv-libs"
            echo "   · Arch Linux:    sudo pacman -S mpv"
        fi

    elif ! "$PYTHON" -c "import gi; gi.require_version('Adw', '1')" &> /dev/null; then
        echo "[ERROR] MISSING DEPENDENCY: LibAdwaita"
        echo "   Your system is missing LibAdwaita (Adw 1), required for the UI."
        
        # Try automated installation
        if install_dependencies "adwaita" "$DISTRO"; then
            INSTALLED=true
        else
            # Show manual instructions as fallback
            echo ""
            echo "   Manual installation instructions:"
            echo "   · Debian/Ubuntu: sudo apt install gir1.2-adw-1"
            echo "   · Fedora:        sudo dnf install libadwaita"
            echo "   · Arch Linux:    sudo pacman -S libadwaita"
        fi
    else
        echo "   Please check the error output above for details."
    fi
    
    # If dependencies were installed, try running the GUI again
    if [ "$INSTALLED" = true ]; then
        echo ""
        echo "[RETRY] Retrying GUI startup..."
        exec "$0"  # Re-run this script
    fi
    
    exit $EXIT_CODE
fi
