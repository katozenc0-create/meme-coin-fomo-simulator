"""Small standard-library server for the Meme Coin FOMO Simulator."""

from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
import os
import re
import threading
import time
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
POLYMARKET_CLOB_BOOK_URL = "https://clob.polymarket.com/book"
POLYMARKET_CLOB_HISTORY_URL = "https://clob.polymarket.com/prices-history"
SERVED_EXTENSIONS = {".html", ".css", ".js", ".json", ".csv", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".txt", ".md"}


def _http_get_json(url: str, timeout: float = 8.0) -> object:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "practice-simulator/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https host
        return json.loads(response.read().decode("utf-8"))


# Polite upstream access: a small TTL cache (successful responses only) and at most
# UPSTREAM_CONCURRENCY simultaneous requests to Polymarket, so the live board and the
# training loader do not hammer the public API or trip its rate limits.
UPSTREAM_CONCURRENCY = 4
CACHE_MAX_ENTRIES = 1024
_cache: dict[str, tuple[float, object]] = {}
_cache_lock = threading.Lock()
_upstream_slots = threading.BoundedSemaphore(UPSTREAM_CONCURRENCY)
cache_stats = {"hits": 0, "misses": 0}


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()
        cache_stats.update(hits=0, misses=0)


def _cached_get_json(url: str, ttl: float) -> object:
    now = time.monotonic()
    with _cache_lock:
        entry = _cache.get(url)
        if entry and entry[0] > now:
            cache_stats["hits"] += 1
            return entry[1]
        cache_stats["misses"] += 1
    with _upstream_slots:
        payload = _http_get_json(url)
    with _cache_lock:
        if len(_cache) >= CACHE_MAX_ENTRIES:
            for key, _ in sorted(_cache.items(), key=lambda item: item[1][0])[: CACHE_MAX_ENTRIES // 4]:
                _cache.pop(key, None)
        _cache[url] = (time.monotonic() + ttl, payload)
    return payload


def fetch_polymarket_markets(limit: int = 20) -> list[dict]:
    """Read-only snapshot of active Polymarket markets (public Gamma API, no keys, no trading)."""
    query = urlencode({"active": "true", "closed": "false", "limit": max(1, min(limit, 100)), "order": "volume24hr", "ascending": "false"})
    payload = _cached_get_json(f"{POLYMARKET_GAMMA_URL}?{query}", ttl=30)
    markets = payload if isinstance(payload, list) else payload.get("data", []) if isinstance(payload, dict) else []
    keys = ("id", "question", "slug", "outcomes", "outcomePrices", "bestBid", "bestAsk", "volumeNum", "volume", "liquidityNum", "liquidity", "endDate", "clobTokenIds")
    return [{key: market.get(key) for key in keys if key in market} for market in markets if isinstance(market, dict)]


MARKET_ID = re.compile(r"^[0-9]{1,12}$")
TOKEN_ID = re.compile(r"^[0-9]{1,100}$")


def fetch_polymarket_book(token_id: str, depth: int = 50) -> dict:
    """Read-only CLOB order book for one outcome token (public endpoint, no keys)."""
    if not TOKEN_ID.match(token_id):
        raise ValueError("token id must be numeric")
    payload = _cached_get_json(f"{POLYMARKET_CLOB_BOOK_URL}?{urlencode({'token_id': token_id})}", ttl=5)
    if not isinstance(payload, dict):
        raise ValueError("unexpected response")

    def levels(side: object) -> list[dict]:
        rows = side if isinstance(side, list) else []
        clean = []
        for row in rows:
            if isinstance(row, dict):
                try:
                    clean.append({"price": float(row.get("price")), "size": float(row.get("size"))})
                except (TypeError, ValueError):
                    continue
        return clean

    asks = sorted(levels(payload.get("asks")), key=lambda level: level["price"])[:depth]
    bids = sorted(levels(payload.get("bids")), key=lambda level: -level["price"])[:depth]
    return {"tokenId": token_id, "asks": asks, "bids": bids}


def fetch_polymarket_market(market_id: str) -> dict:
    """Read-only snapshot of one Polymarket market by numeric id."""
    if not MARKET_ID.match(market_id):
        raise ValueError("market id must be numeric")
    payload = _cached_get_json(f"{POLYMARKET_GAMMA_URL}/{market_id}", ttl=10)
    if not isinstance(payload, dict):
        raise ValueError("unexpected response")
    keys = ("id", "question", "slug", "outcomes", "outcomePrices", "bestBid", "bestAsk", "volumeNum", "volume", "liquidityNum", "liquidity", "endDate", "closed", "clobTokenIds")
    return {key: payload.get(key) for key in keys if key in payload}


def fetch_resolved_markets(limit: int = 100, offset: int = 0) -> list[dict]:
    """Read-only list of closed Polymarket markets (most recently ended first) for training."""
    query = urlencode({"closed": "true", "limit": max(1, min(limit, 500)), "offset": max(0, min(offset, 100000)), "order": "endDate", "ascending": "false"})
    payload = _cached_get_json(f"{POLYMARKET_GAMMA_URL}?{query}", ttl=300)
    markets = payload if isinstance(payload, list) else payload.get("data", []) if isinstance(payload, dict) else []
    keys = ("id", "question", "outcomes", "outcomePrices", "endDate", "closedTime", "closed", "clobTokenIds", "volumeNum")
    return [{key: market.get(key) for key in keys if key in market} for market in markets if isinstance(market, dict)]


def fetch_price_history(token_id: str, fidelity: int = 720) -> list[dict]:
    """Read-only CLOB price history ([{t, p}]) for one outcome token."""
    if not TOKEN_ID.match(token_id):
        raise ValueError("token id must be numeric")
    query = urlencode({"market": token_id, "interval": "max", "fidelity": max(1, min(fidelity, 10080))})
    payload = _cached_get_json(f"{POLYMARKET_CLOB_HISTORY_URL}?{query}", ttl=3600)
    rows = payload.get("history", []) if isinstance(payload, dict) else []
    history = []
    for row in rows:
        if isinstance(row, dict):
            try:
                history.append({"t": int(row["t"]), "p": float(row["p"])})
            except (KeyError, TypeError, ValueError):
                continue
    return history


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
        if route == "/api/polymarket/resolved":
            query = parse_qs(urlparse(self.path).query)
            try:
                limit = int(query.get("limit", ["100"])[0])
                offset = int(query.get("offset", ["0"])[0])
            except ValueError:
                limit, offset = 100, 0
            try:
                self._send_json({"source": "polymarket-gamma", "readOnly": True, "markets": fetch_resolved_markets(limit, offset)})
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
                self._send_json({"error": f"Polymarket data unavailable: {error}"}, HTTPStatus.BAD_GATEWAY)
            return
        if route == "/api/polymarket/history":
            query = parse_qs(urlparse(self.path).query)
            token_id = query.get("token_id", [""])[0]
            if not TOKEN_ID.match(token_id):
                self._send_json({"error": "token_id must be a numeric CLOB token id"}, HTTPStatus.BAD_REQUEST)
                return
            try:
                fidelity = int(query.get("fidelity", ["720"])[0])
            except ValueError:
                fidelity = 720
            try:
                self._send_json({"source": "polymarket-clob", "readOnly": True, "history": fetch_price_history(token_id, fidelity)})
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
                self._send_json({"error": f"Polymarket price history unavailable: {error}"}, HTTPStatus.BAD_GATEWAY)
            return
        if route == "/api/polymarket/book":
            token_id = parse_qs(urlparse(self.path).query).get("token_id", [""])[0]
            if not TOKEN_ID.match(token_id):
                self._send_json({"error": "token_id must be a numeric CLOB token id"}, HTTPStatus.BAD_REQUEST)
                return
            try:
                self._send_json({"source": "polymarket-clob", "readOnly": True, "book": fetch_polymarket_book(token_id)})
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
                self._send_json({"error": f"Polymarket order book unavailable: {error}"}, HTTPStatus.BAD_GATEWAY)
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