"""Small standard-library server for the Meme Coin FOMO Simulator."""

from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
import os
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlencode, urlparse


ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
# Only static assets the game needs are served; source files, dotfiles and .git stay private.
POLYMARKET_GAMMA_URL = "https://gamma-api.polymarket.com/markets"
SERVED_EXTENSIONS = {".html", ".css", ".js", ".json", ".csv", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".txt", ".md"}


def _http_get_json(url: str, timeout: float = 8.0) -> object:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "practice-simulator/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https host
        return json.loads(response.read().decode("utf-8"))


def fetch_polymarket_markets(limit: int = 20) -> list[dict]:
    """Read-only snapshot of active Polymarket markets (public Gamma API, no keys, no trading)."""
    query = urlencode({"active": "true", "closed": "false", "limit": max(1, min(limit, 100)), "order": "volume24hr", "ascending": "false"})
    payload = _http_get_json(f"{POLYMARKET_GAMMA_URL}?{query}")
    markets = payload if isinstance(payload, list) else payload.get("data", []) if isinstance(payload, dict) else []
    keys = ("id", "question", "slug", "outcomes", "outcomePrices", "bestBid", "bestAsk", "volumeNum", "volume", "liquidityNum", "liquidity", "endDate")
    return [{key: market.get(key) for key in keys if key in market} for market in markets if isinstance(market, dict)]


MARKET_ID = re.compile(r"^[0-9]{1,12}$")


def fetch_polymarket_market(market_id: str) -> dict:
    """Read-only snapshot of one Polymarket market by numeric id."""
    if not MARKET_ID.match(market_id):
        raise ValueError("market id must be numeric")
    payload = _http_get_json(f"{POLYMARKET_GAMMA_URL}/{market_id}")
    if not isinstance(payload, dict):
        raise ValueError("unexpected response")
    keys = ("id", "question", "slug", "outcomes", "outcomePrices", "bestBid", "bestAsk", "volumeNum", "volume", "liquidityNum", "liquidity", "endDate", "closed")
    return {key: payload.get(key) for key in keys if key in payload}


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
        if route == "/api/polymarket/markets":
            try:
                limit = int(parse_qs(urlparse(self.path).query).get("limit", ["20"])[0])
            except ValueError:
                limit = 20
            try:
                self._send_json({"source": "polymarket-gamma", "readOnly": True, "markets": fetch_polymarket_markets(limit)})
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
                self._send_json({"error": f"Polymarket data unavailable: {error}"}, HTTPStatus.BAD_GATEWAY)
            return
        if route == "/api/polymarket/market":
            market_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
            if not MARKET_ID.match(market_id):
                self._send_json({"error": "id must be a numeric Polymarket market id"}, HTTPStatus.BAD_REQUEST)
                return
            try:
                self._send_json({"source": "polymarket-gamma", "readOnly": True, "market": fetch_polymarket_market(market_id)})
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
                self._send_json({"error": f"Polymarket data unavailable: {error}"}, HTTPStatus.BAD_GATEWAY)
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