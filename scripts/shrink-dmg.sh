#!/bin/sh
# Recompress the DMG with LZMA (~25% smaller than electron-builder's zlib
# default; electron-builder itself only goes up to lzfse). LZMA DMGs need
# macOS 10.15+ to open, which Electron requires anyway.
set -e
for f in dist/*.dmg; do
  hdiutil convert "$f" -format ULMO -o "$f.ulmo" -quiet
  mv "$f.ulmo.dmg" "$f"
done
# The blockmap is only for electron-updater deltas and no longer matches.
rm -f dist/*.blockmap
