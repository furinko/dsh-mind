#!/usr/bin/env bash
# Installs optional document dependencies outside the source, runtime and source folders.
set -euo pipefail
task_python="${1:-python3}"
task_base="${DSH_MIND_PARSER_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/dsh-mind/document-parser}"
task_scripts="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p -- "$task_base"
chmod 700 -- "$task_base"
"$task_python" -m venv "$task_base/venv"
"$task_base/venv/bin/python3" -m pip install --disable-pip-version-check -r "$task_scripts/information-parser-requirements.txt"
"$task_base/venv/bin/python3" -I -B "$task_scripts/information-parser.py" --capabilities
