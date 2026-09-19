#!/bin/bash
# Build script for lab.geobim.app
# Auto-generates models/index.json from public/models/*.ifc, then runs Vite build

MODELS_DIR="public/models"
INDEX="$MODELS_DIR/index.json"

echo "[ Scanning $MODELS_DIR for IFC files... ]"

# Generate index.json from *.ifc files
echo "[" > "$INDEX"
first=true
for f in "$MODELS_DIR"/*.ifc; do
  [ -f "$f" ] || continue
  filename=$(basename "$f")
  # Human-readable name: strip extension, replace underscores with spaces
  name=$(basename "$f" .ifc | sed 's/_/ /g')
  size=$(du -h "$f" | cut -f1)
  if [ "$first" = true ]; then
    first=false
  else
    echo "," >> "$INDEX"
  fi
  printf '  { "name": "%s", "file": "%s", "size": "%s" }' "$name" "$filename" "$size" >> "$INDEX"
done
echo "" >> "$INDEX"
echo "]" >> "$INDEX"

echo "[ Generated $INDEX ]"
cat "$INDEX"

# Sync web-ifc WASM binaries from node_modules so they always match the
# installed web-ifc version (mismatched wasm/JS causes silent load failures)
echo "[ Syncing web-ifc WASM binaries ]"
mkdir -p public/wasm
cp node_modules/web-ifc/web-ifc.wasm node_modules/web-ifc/web-ifc-mt.wasm public/wasm/

echo "[ Running Vite build... ]"
npx vite build
