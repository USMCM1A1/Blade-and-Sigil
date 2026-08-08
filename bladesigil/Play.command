#!/bin/bash
# Double-click this file to play Blade & Sigil.
# It starts a tiny local web server (needed so the game can read your data files)
# and opens the game in your browser. Close this terminal window to stop.
cd "$(dirname "$0")"
PORT=8137
( sleep 1; open "http://localhost:$PORT" ) &
echo "Blade & Sigil is running at http://localhost:$PORT"
echo "Keep this window open while playing. Press Ctrl+C or close it to quit."
exec python3 -c "
import http.server

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Designer workflow: edit a file, refresh the browser, see the change.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

http.server.ThreadingHTTPServer(('', $PORT), NoCacheHandler).serve_forever()
"
