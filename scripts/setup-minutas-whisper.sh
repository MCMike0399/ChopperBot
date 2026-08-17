#!/usr/bin/env bash
# One-time setup of the local speech-to-text engine the minutas capability
# uses: whisper.cpp (built from source, ARM NEON on the Pi) + a ggml model.
# Everything lands under data/minutas/ (gitignored, on the Pi's SSD):
#
#   data/minutas/whisper.cpp/      source checkout (depth 1)
#   data/minutas/bin/whisper-cli   the binary the capability shells out to
#   data/minutas/models/ggml-<m>.bin   the model (default: small)
#   data/minutas/tools/venv/       build tooling (cmake via PyPI wheel; gTTS
#                                  for generating e2e speech fixtures)
#
# Nothing is installed system-wide. Re-run to upgrade/repair; the capability
# reports "transcriber unavailable" (and keeps the raw drafts) when the binary
# or model is missing. Usage: bash scripts/setup-minutas-whisper.sh [model]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${1:-small}"
BASE="$ROOT/data/minutas"
SRC="$BASE/whisper.cpp"
BIN="$BASE/bin/whisper-cli"
VENV="$BASE/tools/venv"
MODEL_FILE="$BASE/models/ggml-$MODEL.bin"

mkdir -p "$BASE/bin" "$BASE/models" "$BASE/tools"

# 1. Build tooling: cmake from PyPI (the system has none; sudo is off-limits).
if [ ! -x "$VENV/bin/cmake" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip >/dev/null
  "$VENV/bin/pip" install cmake gtts >/dev/null
fi
CMAKE="$VENV/bin/cmake"

# 2. Source checkout.
if [ ! -d "$SRC/.git" ]; then
  rm -rf "$SRC"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$SRC"
fi

# 3. Build (whisper-cli + libwhisper only; no examples/tests needed).
"$CMAKE" -S "$SRC" -B "$SRC/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DBUILD_SHARED_LIBS=OFF
"$CMAKE" --build "$SRC/build" -j 4 --config Release
cp "$SRC/build/bin/whisper-cli" "$BIN"

# 4. Model.
if [ ! -s "$MODEL_FILE" ]; then
  curl -fL --retry 3 \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin" \
    -o "$MODEL_FILE.tmp"
  mv "$MODEL_FILE.tmp" "$MODEL_FILE"
fi

echo "whisper ready: $BIN (model: $MODEL_FILE)"
"$BIN" --help >/dev/null 2>&1 || "$BIN" -h >/dev/null 2>&1 || true
ls -lh "$BIN" "$MODEL_FILE"
