#!/usr/bin/env bash
# Vendor a Whisper ONNX model into lib/vendor/models/ so it lives on disk with
# the extension: no re-download after an extension Remove, no network at runtime.
#
# Usage: scripts/vendor-model.sh [tiny|base|small]     (default: base)
#
# Layout matches what Transformers.js expects for env.localModelPath:
#   lib/vendor/models/onnx-community/whisper-<size>/{config.json,…,onnx/*.onnx}
#
# Quantized (q8) weights are used for both encoder and decoder — int8, the
# well-supported wasm path. fp32 is far larger and stalls session creation.
set -euo pipefail

# base matches DEFAULT_CONFIG.local.model in lib/config.js — small stalls ONNX
# session creation on the single-threaded wasm backend.
SIZE="${1:-base}"
REPO="onnx-community/whisper-${SIZE}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/lib/vendor/models/${REPO}"
BASE="https://huggingface.co/${REPO}/resolve/main"

META=(
  config.json
  generation_config.json
  preprocessor_config.json
  tokenizer.json
  tokenizer_config.json
  special_tokens_map.json
  added_tokens.json
  normalizer.json
  vocab.json
  merges.txt
)

WEIGHTS=(
  onnx/encoder_model_quantized.onnx
  onnx/decoder_model_merged_quantized.onnx
)

mkdir -p "$DEST/onnx"

fetch() {
  local rel="$1" out="$DEST/$1"
  if [[ -s "$out" ]]; then
    echo "  = $rel (cached)"
    return 0
  fi
  echo "  ↓ $rel"
  if ! curl -fsSL --retry 3 -o "$out.part" "$BASE/$rel"; then
    rm -f "$out.part"
    return 1
  fi
  mv "$out.part" "$out"
}

echo "==> vendoring $REPO into lib/vendor/models/"
for f in "${META[@]}"; do
  fetch "$f" || echo "  ! $f not in repo, skipping"
done
for f in "${WEIGHTS[@]}"; do
  fetch "$f" || { echo "  ✗ required weight missing: $f" >&2; exit 1; }
done

echo "==> done:"
du -sh "$DEST" | awk '{print "    " $1 "  " $2}'
