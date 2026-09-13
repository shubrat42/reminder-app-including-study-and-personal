#!/bin/bash
# ============================================================
# Switchr — Start local server (double-click me)
# ------------------------------------------------------------
# Serves the app at:  http://localhost:8000
# Keep the window open while using the app.
# Closing this window stops the server. That's it!
# ============================================================

# Always serve from the folder this script lives in,
# no matter where it's launched from.
cd "$(dirname "$0")"

echo ""
echo "✅  Switchr is running at:  http://localhost:8000"
echo "    Keep this window open — closing it stops the server."
echo ""

# Open the app in your default browser, then start the server.
open "http://localhost:8000"
python3 -m http.server 8000
