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
POLYMARKET_GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events"
POLYMARKET_CLOB_BOOK_URL = "https://clob.polymarket.com/book"
POLYMARKET_CLOB_HISTORY_URL = "https://clob.polymarket.com/prices-history"
AUTOPILOT_STATE = Path(os.environ.get("AUTOPILOT_STATE", str(ROOT / "data" / "autopilot.json")))
EXCHANGE_STATUS = Path(os.environ.get("EXCHANGE_STATUS", str(ROOT / "data" / "exchange-status.json")))
ACCOUNT_BOX = Path(os.environ.get("ACCOUNT_BOX", str(ROOT / "data" / "account.enc.json")))
# The same policy is in each page's <meta http-equiv="Content-Security-Policy"> (GitHub Pages cannot
# send headers); tests keep the two identical. frame-ancestors only works as a header.
CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; manifest-src 'self'; worker-src 'self'; connect-src 'self' https://gamma-api.polymarket.com https://clob.polymarket.com https://raw.githubusercontent.com https://api.exchange.coinbase.com https://api.mainnet-beta.solana.com https://solana-rpc.publicnode.com https://lite-api.jup.ag; object-src 'none'; base-uri 'none'; form-action 'none'"

mimetypes.add_type("application/manifest+json", ".webmanifest")   # PWA manifest (home-screen install)
SERVED_EXTENSIONS = {".webmanifest", ".html", ".css", ".js", ".json", ".csv", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".txt", ".md"}


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
    keys = ("id", "question", "slug", "outcomes", "outcomePrices", "bestBid", "bestAsk", "volumeNum", "volume", "liquidityNum", "liquidity", "endDate", "clobTokenIds", "negRisk", "feesEnabled", "takerBaseFee", "feeSchedule", "feeType")
    return [_compact_market(market, keys) for market in markets if isinstance(market, dict)]


MARKET_ID = re.compile(r"[0-9]{1,12}")
TOKEN_ID = re.compile(r"[0-9]{1,100}")


def fetch_polymarket_book(token_id: str, depth: int = 50) -> dict:
    """Read-only CLOB order book for one outcome token (public endpoint, no keys)."""
    if not TOKEN_ID.fullmatch(token_id):
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
    if not MARKET_ID.fullmatch(market_id):
        raise ValueError("market id must be numeric")
    payload = _cached_get_json(f"{POLYMARKET_GAMMA_URL}/{market_id}", ttl=10)
    if not isinstance(payload, dict):
        raise ValueError("unexpected response")
    keys = ("id", "question", "slug", "outcomes", "outcomePrices", "bestBid", "bestAsk", "volumeNum", "volume", "liquidityNum", "liquidity", "endDate", "closed", "closedTime", "clobTokenIds", "negRisk", "feesEnabled", "takerBaseFee", "feeSchedule", "feeType")
    return _compact_market(payload, keys)


DATE = re.compile(r"\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?")


def fetch_resolved_markets(limit: int = 100, offset: int = 0, end_min: str | None = None, end_max: str | None = None) -> list[dict]:
    """Read-only list of closed Polymarket markets for training.

    With a window of scheduled end dates (end_min..end_max, validated by the handler) whole
    EVENTS are fetched and flattened, so every candidate of an event arrives together: taking
    "the first 100 markets" of a window could keep an event's losers and drop its winner,
    biasing the sample toward NO. `limit` then counts events. Gamma rejects ordering combined
    with a date window, so a window is sent unordered.
    Without a window: markets, most recent scheduled end first.
    """
    keys = ("id", "question", "slug", "outcomes", "outcomePrices", "endDate", "closedTime", "closed", "clobTokenIds", "volumeNum", "negRisk", "feesEnabled", "takerBaseFee", "feeSchedule", "feeType")
    if end_min or end_max:
        params = {"closed": "true", "limit": max(1, min(limit, 100)), "offset": max(0, min(offset, 900))}
        if end_min:
            params["end_date_min"] = end_min
        if end_max:
            params["end_date_max"] = end_max
        payload = _cached_get_json(f"{POLYMARKET_GAMMA_EVENTS_URL}?{urlencode(params)}", ttl=300)
        events = payload if isinstance(payload, list) else []
        flat = []
        for event in events:
            if not isinstance(event, dict):
                continue
            for market in event.get("markets") or []:
                if isinstance(market, dict):
                    compact = _compact_market(market, keys)
                    compact["eventId"] = str(event.get("id"))
                    flat.append(compact)
        return flat
    query = urlencode({"closed": "true", "limit": max(1, min(limit, 500)), "offset": max(0, min(offset, 100000)), "order": "endDate", "ascending": "false"})
    payload = _cached_get_json(f"{POLYMARKET_GAMMA_URL}?{query}", ttl=300)
    markets = payload if isinstance(payload, list) else payload.get("data", []) if isinstance(payload, dict) else []
    return [_compact_market(market, keys) for market in markets if isinstance(market, dict)]


def fetch_price_history(token_id: str, fidelity: int = 720) -> list[dict]:
    """Read-only CLOB price history ([{t, p}]) for one outcome token."""
    if not TOKEN_ID.fullmatch(token_id):
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


def _compact_market(market: dict, keys: tuple[str, ...]) -> dict:
    """Selected fields plus a flat eventId (the full nested events objects are large)."""
    compact = {key: market.get(key) for key in keys if key in market}
    events = market.get("events")
    if isinstance(events, list) and events and isinstance(events[0], dict) and events[0].get("id") is not None:
        compact["eventId"] = str(events[0]["id"])
        if isinstance(events[0].get("slug"), str):
            compact["eventSlug"] = events[0]["slug"]
    return compact


def autopilot_status(path: Path) -> dict:
    """Read-only summary of the autopilot's state file (virtual money) for the browser."""
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"available": False, "reason": "no autopilot state yet: run node autopilot.js"}
    except (OSError, ValueError) as error:
        return {"available": False, "reason": f"autopilot state unreadable: {error}"}
    if not isinstance(state, dict) or not isinstance(state.get("account"), dict):
        return {"available": False, "reason": "autopilot state has an unexpected shape"}
    model = state.get("model") if isinstance(state.get("model"), dict) else None
    positions = state.get("positions") if isinstance(state.get("positions"), dict) else {}
    return {
        "available": True, "virtualMoney": True,
        "createdAt": state.get("createdAt"), "lastTick": state.get("lastTick"),
        "account": state["account"],
        # The model's source and evidence gate only (its parameters are not needed to watch it).
        "model": {"source": model.get("source"), "trainedAt": model.get("trainedAt"), "kind": model.get("kind"), "gate": model.get("gate")} if model else None,
        "positions": [{"id": key, **value} for key, value in positions.items() if isinstance(value, dict)],
        "watching": len(state.get("watch") or []),
        "history": (state.get("history") or [])[:100],
        "log": (state.get("log") or [])[:100],
        "trainings": (state.get("trainings") or [])[:30],
    }


def exchange_status(path: Path) -> dict:
    """The crypto exchange autopilot's public status (virtual money), as written by --status-out."""
    try:
        status = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"available": False, "reason": "no exchange status yet: run node exchange-autopilot.js --status-out data/exchange-status.json"}
    except (OSError, ValueError) as error:
        return {"available": False, "reason": f"exchange status unreadable: {error}"}
    if not isinstance(status, dict) or status.get("kind") != "exchange" or not isinstance(status.get("account"), dict):
        return {"available": False, "reason": "exchange status has an unexpected shape"}
    return status


def account_box(path: Path) -> dict | None:
    """The sealed account snapshot, only if it really is a sealed box (never plaintext balances)."""
    try:
        box = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(box, dict) or box.get("v") != 1 or not isinstance(box.get("ct"), str) or "balances" in box:
        return None
    return {key: box[key] for key in ("v", "alg", "label", "iterations", "salt", "iv", "ct", "sealedAt") if key in box}


class SimulatorHandler(BaseHTTPRequestHandler):
    server_version = "FomoPractice/1.0"

    def _headers(self, content_type: str, length: int, compressed: bool = False) -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        # API responses are live data (the server already caches upstream briefly): never let the
        # browser reuse them. Static files revalidate so new HTML never runs against stale JS.
        self.send_header("Cache-Control", "no-store" if content_type.startswith("application/json") else "no-cache")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        if content_type.startswith("text/html"):
            self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY + "; frame-ancestors 'none'")
            self.send_header("X-Frame-Options", "DENY")
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
        if route == "/api/autopilot/status":
            self._send_json(autopilot_status(self.server.autopilot_state if hasattr(self.server, "autopilot_state") else AUTOPILOT_STATE))
            return
        if route == "/api/account":
            # Ciphertext only (account-sync.js seals it); opened in the owner's browser.
            box = account_box(getattr(self.server, "account_box", ACCOUNT_BOX))
            if box is None:
                self._send_json({"error": "no linked account"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(box)
            return
        if route == "/api/exchange/status":
            self._send_json(exchange_status(getattr(self.server, "exchange_status", EXCHANGE_STATUS)))
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
            if not MARKET_ID.fullmatch(market_id):
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
            end_min = query.get("end_min", [None])[0]
            end_max = query.get("end_max", [None])[0]
            if (end_min and not DATE.fullmatch(end_min)) or (end_max and not DATE.fullmatch(end_max)):
                self._send_json({"error": "end_min/end_max must be ISO dates"}, HTTPStatus.BAD_REQUEST)
                return
            try:
                self._send_json({"source": "polymarket-gamma", "readOnly": True, "markets": fetch_resolved_markets(limit, offset, end_min, end_max)})
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
                self._send_json({"error": f"Polymarket data unavailable: {error}"}, HTTPStatus.BAD_GATEWAY)
            return
        if route == "/api/polymarket/history":
            query = parse_qs(urlparse(self.path).query)
            token_id = query.get("token_id", [""])[0]
            if not TOKEN_ID.fullmatch(token_id):
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
            if not TOKEN_ID.fullmatch(token_id):
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
    parser.add_argument("--autopilot-state", default=str(AUTOPILOT_STATE), help="autopilot state file shown at /api/autopilot/status")
    parser.add_argument("--account-box", default=str(ACCOUNT_BOX), help="sealed account snapshot shown at /api/account")
    parser.add_argument("--exchange-status", default=str(EXCHANGE_STATUS), help="exchange autopilot status file shown at /api/exchange/status")
    args = parser.parse_args(argv)
    server = ThreadingHTTPServer((args.host, args.port), SimulatorHandler)
    server.autopilot_state = Path(args.autopilot_state)
    server.exchange_status = Path(args.exchange_status)
    server.account_box = Path(args.account_box)
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