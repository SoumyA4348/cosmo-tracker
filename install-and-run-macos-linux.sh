#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PYTHON=""
for candidate in python3.13 python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 \
    && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 13) else 1)' 2>/dev/null; then
    PYTHON="$candidate"
    break
  fi
done

if [[ -z "$PYTHON" ]]; then
  echo "Python 3.13 or later is required."
  echo "Install it from https://www.python.org/downloads/ and run this script again."
  exit 1
fi

if [[ ! -x ".venv/bin/python" ]]; then
  echo "Creating the app's private Python environment..."
  "$PYTHON" -m venv .venv
fi

echo "Installing Cosmo-Tracker dependencies..."
".venv/bin/python" -m pip install --upgrade pip
".venv/bin/python" -m pip install -r requirements.txt

echo
echo "Cosmo-Tracker is starting. Open http://127.0.0.1:8080 in your browser."
echo "Keep this terminal window open while you use the app."
exec ".venv/bin/python" -m uvicorn main:app --host 127.0.0.1 --port 8080