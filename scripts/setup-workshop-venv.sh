#!/usr/bin/env bash
# One-time setup of the Python venv the workshop capability's sandboxed
# code-execution tool uses (data/workshop/venv). The venv is bind-mounted
# READ-ONLY into the bwrap sandbox at /opt/venv, so sessions can import these
# libraries but never modify them. Re-run to upgrade/repair; the bot degrades
# to the system python3 (stdlib only) when the venv is missing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/data/workshop/venv"

mkdir -p "$ROOT/data/workshop"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install \
  openpyxl \
  python-docx \
  python-pptx \
  reportlab \
  matplotlib \
  pypdf \
  pdfplumber \
  numpy \
  pandas \
  pillow

echo "workshop venv ready: $VENV"
"$VENV/bin/python3" -c "import openpyxl, docx, pptx, reportlab, matplotlib, numpy, pandas, PIL, pypdf, pdfplumber; print('all imports ok')"
