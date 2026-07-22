#!/usr/bin/env bash
# Vendor the local-Whisper runtime (Transformers.js + ONNX Runtime Web) into
# lib/vendor/. These files are gitignored (23 MB wasm) — run this before a build
# that needs the local STT engine. CI runs it too.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/lib/vendor"
VER="4.2.0"

if [[ -f "$VENDOR/ort/ort-wasm-simd-threaded.asyncify.wasm" ]]; then
  echo "==> vendor already present, skipping (delete lib/vendor to refresh)"
  exit 0
fi

TMP="$(mktemp -d)"
echo "==> installing @huggingface/transformers@$VER in $TMP"
( cd "$TMP" && echo '{}' > package.json && bun add "@huggingface/transformers@$VER" )

TX="$TMP/node_modules/@huggingface/transformers/dist"
ORT="$TMP/node_modules/onnxruntime-web/dist"

COMMON="$TMP/node_modules/onnxruntime-common/dist/esm"

mkdir -p "$VENDOR/ort/onnxruntime-common"
cp "$TX/transformers.web.min.js" "$VENDOR/transformers.min.js"
cp "$ORT/ort.webgpu.bundle.min.mjs" "$VENDOR/ort/"
cp "$ORT/ort-wasm-simd-threaded.asyncify.mjs" "$VENDOR/ort/"
cp "$ORT/ort-wasm-simd-threaded.asyncify.wasm" "$VENDOR/ort/"
cp "$COMMON"/*.js "$VENDOR/ort/onnxruntime-common/"

# MV3 CSP blocks inline import maps, so rewrite Transformers.js's bare module
# specifiers to relative paths into the vendored build (portable sed GNU+BSD).
sed -i.bak \
  -e 's|onnxruntime-web/webgpu|./ort/ort.webgpu.bundle.min.mjs|g' \
  -e 's|onnxruntime-common|./ort/onnxruntime-common/index.js|g' \
  "$VENDOR/transformers.min.js"
rm -f "$VENDOR/transformers.min.js.bak"

rm -rf "$TMP"
echo "==> vendored into $VENDOR"
