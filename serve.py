#!/usr/bin/env python3
"""
Static file server with HTTP Range request support.
Required for serving PMTiles files (which use byte-range fetching).

Usage:
    python serve.py [port] [directory]
    python serve.py 8080 viewer          # default
"""
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path


class RangeHTTPRequestHandler(SimpleHTTPRequestHandler):

    def do_GET(self):
        path = self.translate_path(self.path)
        range_header = self.headers.get("Range")

        if os.path.isfile(path) and range_header:
            self._serve_range(path, range_header)
        else:
            super().do_GET()

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
    directory = sys.argv[2]      if len(sys.argv) > 2 else str(Path(__file__).parent / "viewer")

    os.chdir(directory)
    print(f"Serving {directory}/ on http://localhost:{port}")
    print("Ctrl-C to stop.\n")
    HTTPServer(("", port), RangeHTTPRequestHandler).serve_forever()
