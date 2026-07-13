#!/usr/bin/env python3
"""
Static file server with HTTP Range request support.
Required for serving PMTiles files (which use byte-range fetching).

Any request for a path that doesn't exist locally (e.g. tiles/*.pmtiles on a
laptop checkout with no local pmtiles files) is transparently proxied to
REMOTE_BASE, authenticated with a Cloudflare Access service token. Set
CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (e.g. via a gitignored .env
sourced by serve.sh) to enable this — without them, missing paths just 404
as before.

Usage:
    python serve.py [port] [directory]
    python serve.py 8080                 # default: serves this script's own directory
"""
import os
import shutil
import sys
import urllib.error
import urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

REMOTE_BASE = os.environ.get("TILES_REMOTE_BASE", "https://dalarna-mtb.hammer-tour.com")
CF_CLIENT_ID     = os.environ.get("CF_ACCESS_CLIENT_ID")
CF_CLIENT_SECRET = os.environ.get("CF_ACCESS_CLIENT_SECRET")


class RangeHTTPRequestHandler(SimpleHTTPRequestHandler):

    def do_GET(self):
        path = self.translate_path(self.path)
        range_header = self.headers.get("Range")

        if os.path.isdir(path) or os.path.isfile(path):
            if os.path.isfile(path) and range_header:
                self._serve_range(path, range_header)
            else:
                super().do_GET()
        else:
            self._proxy_remote(self.path)

    def _proxy_remote(self, path: str) -> None:
        if not (CF_CLIENT_ID and CF_CLIENT_SECRET):
            self.send_error(404, "Not found locally (no CF Access credentials set for remote fallback)")
            return

        url = REMOTE_BASE.rstrip("/") + path
        headers = {
            "CF-Access-Client-Id": CF_CLIENT_ID,
            "CF-Access-Client-Secret": CF_CLIENT_SECRET,
            # Cloudflare's bot protection blocks the default "Python-urllib/x.y"
            # User-Agent (error 1010) even with valid Access credentials.
            "User-Agent": "Mozilla/5.0 (compatible; dalarna-mtb-local-proxy/1.0)",
        }
        range_header = self.headers.get("Range")
        if range_header:
            headers["Range"] = range_header

        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                self.send_response(resp.status)
                for h in ("Content-Type", "Content-Length", "Content-Range",
                          "Accept-Ranges", "ETag", "Cache-Control"):
                    val = resp.headers.get(h)
                    if val:
                        self.send_header(h, val)
                self.end_headers()
                shutil.copyfileobj(resp, self.wfile)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            try:
                self.wfile.write(e.read())
            except BrokenPipeError:
                pass
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:
            try:
                self.send_error(502, f"Upstream fetch failed: {e}")
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass

    def _serve_range(self, path: str, range_header: str) -> None:
        try:
            file_size = os.path.getsize(path)
            unit, ranges_str = range_header.split("=", 1)
            if unit != "bytes":
                self.send_error(400, "Only byte ranges supported")
                return

            start_str, end_str = ranges_str.strip().split("-", 1)
            start = int(start_str) if start_str else 0
            end   = int(end_str)   if end_str   else file_size - 1
            end   = min(end, file_size - 1)

            if start > end or start >= file_size:
                self.send_error(416, "Range not satisfiable")
                return

            length = end - start + 1
            with open(path, "rb") as f:
                f.seek(start)
                data = f.read(length)

            self.send_response(206)
            self.send_header("Content-Type",   self.guess_type(path))
            self.send_header("Content-Length",  str(len(data)))
            self.send_header("Content-Range",  f"bytes {start}-{end}/{file_size}")
            self.send_header("Accept-Ranges",  "bytes")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)

        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self.send_error(500, str(e))
            except BrokenPipeError:
                pass

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        if args and str(args[1]) not in ("200", "206", "304"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port      = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    directory = sys.argv[2]      if len(sys.argv) > 2 else str(Path(__file__).parent)

    os.chdir(directory)
    print(f"Serving {directory}/ on http://localhost:{port}")
    print("Ctrl-C to stop.\n")
    HTTPServer(("", port), RangeHTTPRequestHandler).serve_forever()
