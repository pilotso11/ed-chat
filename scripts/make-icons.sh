#!/usr/bin/env bash
# Renders every icon from build/icon.svg. Needs ImageMagick 7 (magick) on PATH.
# Run from the repository root after changing the SVG: bash scripts/make-icons.sh
set -euo pipefail

svg=build/icon.svg
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# No timestamps, so an unchanged SVG gives unchanged files.
render() {
  magick -background none -density 400 "$svg" -resize "$1" \
    -define png:exclude-chunks=date,time,tIME "$2"
}

render 1024x1024 build/icon.png

# App and installer icon.
for s in 16 24 32 48 64 128 256; do render "${s}x${s}" "$tmp/ico-$s.png"; done
magick "$tmp"/ico-{16,24,32,48,64,128,256}.png build/icon.ico

# Microsoft Store tiles.
render 50x50 build/appx/StoreLogo.png
render 44x44 build/appx/Square44x44Logo.png
render 150x150 build/appx/Square150x150Logo.png
render 150x150 "$tmp/wide.png"
magick -size 310x150 xc:none "$tmp/wide.png" -gravity center -composite \
  -define png:exclude-chunks=date,time,tIME build/appx/Wide310x150Logo.png

# Tray. Electron picks tray@2x.png on a display scaled to 200%.
render 32x32 resources/tray.png
render 64x64 resources/tray@2x.png
