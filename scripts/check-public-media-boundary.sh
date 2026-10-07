#!/usr/bin/env bash
# Fail if full masters (or other non-preview audio) appear under the public tree.
# Previews must be named *-preview.<ext>. Full masters belong in Pinata private
# storage or the ignored private-media/ mount — never in git or public/.
set -euo pipefail

root="${1:-.}"
fail=0

audio_dir="$root/public/assets/audio"
if [ -e "$audio_dir" ]; then
  echo "FAIL: $audio_dir must not exist. Full masters are not public assets."
  if [ -d "$audio_dir" ]; then
    find "$audio_dir" -type f -print | sed 's/^/  /' || true
  fi
  fail=1
fi

preview_dir="$root/public/assets/audio-preview"
if [ -d "$preview_dir" ]; then
  while IFS= read -r -d '' f; do
    base="$(basename "$f")"
    # Allow preview manifests and gitkeep only as non-audio sidecars.
    case "$base" in
      _previews.json|_previews-ep1.json|.gitkeep) continue ;;
    esac
    case "$base" in
      *-preview.mp3|*-preview.wav|*-preview.flac|*-preview.m4a|*-preview.ogg|*-preview.aac|*-preview.opus|*-preview.aif|*-preview.aiff)
        continue
        ;;
      *)
        echo "FAIL: non-preview public audio path: $f"
        echo "  Only *-preview.<ext> clips are allowed under public/assets/audio-preview/."
        fail=1
        ;;
    esac
  done < <(find "$preview_dir" -type f \( \
    -iname '*.mp3' -o -iname '*.wav' -o -iname '*.flac' -o -iname '*.m4a' \
    -o -iname '*.ogg' -o -iname '*.aac' -o -iname '*.opus' -o -iname '*.aif' \
    -o -iname '*.aiff' -o -iname '*.wma' \
  \) -print0)
fi

if [ "$fail" -ne 0 ]; then
  echo "Public media boundary check failed."
  exit 1
fi

echo "OK: public media boundary (no public/assets/audio/; audio-preview is *-preview only)"
