#!/bin/sh
# Render each test page with Bloom and with headless Chrome at 1280x800 CSS px (2x), and compare.
#   sh tests/compare.sh [page...]     -> .build/compare/<page>-{bloom,chrome,diff}.png and a summary
set -e
cd "$(dirname "$0")/.."
mkdir -p .build/compare
[ -x .build/page-app ] || perry compile tests/page-app.ts -o .build/page-app
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PAGES="${*:-$(ls tests/pages)}"
for p in $PAGES; do
  dir="$PWD/tests/pages/$p"
  BLOOM_PAGE="$dir/" BLOOM_SCRIPT="40 shot $PWD/.build/compare/$p-bloom.png; 41 quit" ./.build/page-app >/dev/null 2>&1 || true
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1280,800 \
    --virtual-time-budget=2000 --screenshot="$PWD/.build/compare/$p-chrome.png" "file://$dir/index.html" >/dev/null 2>&1 || true
done
python3 -I tests/diff.py .build/compare $PAGES
