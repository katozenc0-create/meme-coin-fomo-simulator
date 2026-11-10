"""Small standard-library server for the Meme Coin FOMO Simulator."""

from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
# Only static assets the game needs are served; source files, dotfiles and .git stay private.
SERVED_EXTENSIONS = {".html", ".css", ".js", ".json", ".csv", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".txt", ".md"}


class SimulatorHandler(BaseHTTPRequestHandler):
    server_version = "FomoPractice/1.0"

    def _headers(self, content_type: str, length: int, compressed: bool = False) -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-cache" if content_type.startswith("text/html") else "public, max-age=3600")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if compressed:
            self.send_header("Content-Encoding", "gzip")

    def _send_bytes(self, body: bytes, content_type: str, status: HTTPStatus = HTTPStatus.OK) -> None:
        accepts_gzip = "gzip" in self.headers.get("Accept-Encoding", "")
        payload = gzip.compress(body, compresslevel=6) if accepts_gzip and len(body) > 700 else body
        self.send_response(status)
        self._headers(content_type, len(payload), payload is not body)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        if route == "/api/health":
            self._send_json({"status": "ok", "mode": "practice", "realFunds": False})
            return
        if route.startswith("/api/"):
            self._send_json({"error": "unknown endpoint"}, HTTPStatus.NOT_FOUND)
            return

        relative = "index.html" if route in ("/", "") else route.lstrip("/")
        target = (ROOT / relative).resolve()
        if ROOT not in target.parents and target != ROOT:
            self._send_bytes(b"Not found", "text/plain; charset=utf-8", HTTPStatus.NOT_FOUND)
            return
        hidden = any(part.startswith(".") for part in target.relative_to(ROOT).parts) if target != ROOT else True
        if hidden or target.suffix.lower() not in SERVED_EXTENSIONS or not target.is_file():
            self._send_bytes(b"Not found", "text/plain; charset=utf-8", HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self._send_bytes(target.read_bytes(), f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type)

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        self._send_bytes(json.dumps(payload).encode(), "application/json; charset=utf-8", status)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"{self.address_string()} - {format_string % args}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Serve the Meme Coin FOMO Simulator locally.")
    parser.add_argument("--host", default=HOST, help=f"interface to bind (default: {HOST})")
    parser.add_argument("--port", type=int, default=PORT, help=f"port to listen on (default: {PORT})")
    args = parser.parse_args(argv)
    server = ThreadingHTTPServer((args.host, args.port), SimulatorHandler)
    print(f"Meme Coin FOMO Simulator: http://{args.host}:{args.port}")
    print("Practice only: no wallet connection and no real funds.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()