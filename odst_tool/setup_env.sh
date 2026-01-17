#!/bin/bash
echo "Setting up virtual environment..."
python -m venv venv
echo "Installing dependencies..."
./venv/bin/pip install -r requirements.txt
echo "Done! You can now run the tool using ./run.sh"
