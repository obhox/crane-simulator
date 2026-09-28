#!/usr/bin/env bash
# Fetch + process the CC0 assets in public/assets (Poly Haven + ambientCG).
# Thin wrapper around fetch-assets.py; see that file for the exact asset list
# and processing. Requires python3 with Pillow + numpy, curl and unzip.
#   scripts/fetch-assets.sh            # fetch whatever is missing
#   scripts/fetch-assets.sh --force    # re-process everything
#   scripts/fetch-assets.sh --only gravel,hdri_day_clear
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c 'import PIL, numpy' 2>/dev/null || { echo "need: python3 -m pip install pillow numpy" >&2; exit 1; }
exec python3 scripts/fetch-assets.py "$@"
