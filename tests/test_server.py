"""Tests for the standard-library simulator server."""

from __future__ import annotations

import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import server


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.SimulatorHandler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self) -> None:
        server.clear_cache()

    def get(self, path: str) -> tuple[int, bytes, dict]:
        try:
            with urllib.request.urlopen(self.base + path) as response:
                return response.status, response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, error.read(), dict(error.headers)

    def test_index_is_served(self) -> None:
        status, body, headers = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Meme Coin FOMO Simulator", body)
        self.assertTrue(headers["Content-Type"].startswith("text/html"))

    def test_health_endpoint(self) -> None:
        status, body, _ = self.get("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"status": "ok", "mode": "practice", "realFunds": False})

    def test_unknown_api_returns_json_404(self) -> None:
        status, body, _ = self.get("/api/prices")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "unknown endpoint")

    def test_private_files_are_not_served(self) -> None:
        for path in ("/server.py", "/.git/config", "/.git/HEAD", "/tests/test_server.py", "/../etc/passwd"):
            with self.subTest(path=path):
                status, _, _ = self.get(path)
                self.assertEqual(status, 404)

    def test_polymarket_proxy_returns_compact_markets(self) -> None:
        original = server._http_get_json
        server._http_get_json = lambda url, timeout=8.0: [{"id": "1", "question": "Q?", "outcomes": '["Yes","No"]', "outcomePrices": '["0.4","0.6"]', "secret": "x"}]
        try:
            status, body, _ = self.get("/api/polymarket/markets?limit=5")
        finally:
            server._http_get_json = original
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertTrue(data["readOnly"])
        self.assertEqual(data["markets"][0]["question"], "Q?")
        self.assertNotIn("secret", data["markets"][0])

    def test_polymarket_proxy_reports_upstream_failure(self) -> None:
        original = server._http_get_json

        def fail(url: str, timeout: float = 8.0) -> object:
            raise urllib.error.URLError("offline")

        server._http_get_json = fail
        try:
            status, body, _ = self.get("/api/polymarket/markets")
        finally:
            server._http_get_json = original
        self.assertEqual(status, 502)
        self.assertIn("unavailable", json.loads(body)["error"])

    def test_single_market_endpoint_validates_id_and_fetches(self) -> None:
        seen = []
        original = server._http_get_json
        server._http_get_json = lambda url, timeout=8.0: seen.append(url) or {"id": "42", "question": "Q?", "outcomePrices": '["0.3","0.7"]', "token": "x"}
        try:
            bad_status, _, _ = self.get("/api/polymarket/market?id=../../etc")
            status, body, _ = self.get("/api/polymarket/market?id=42")
        finally:
            server._http_get_json = original
        self.assertEqual(bad_status, 400)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["market"]["id"], "42")
        self.assertNotIn("token", json.loads(body)["market"])
        self.assertEqual(seen, [server.POLYMARKET_GAMMA_URL + "/42"])

    def test_order_book_endpoint_validates_and_sorts(self) -> None:
        seen = []
        original = server._http_get_json
        server._http_get_json = lambda url, timeout=8.0: seen.append(url) or {
            "asks": [{"price": "0.45", "size": "10"}, {"price": "0.41", "size": "5"}, {"price": "bad", "size": "1"}],
            "bids": [{"price": "0.38", "size": "7"}, {"price": "0.39", "size": "3"}],
            "owner": "secret",
        }
        try:
            bad_status, _, _ = self.get("/api/polymarket/book?token_id=1;rm")
            status, body, _ = self.get("/api/polymarket/book?token_id=12345")
        finally:
            server._http_get_json = original
        self.assertEqual(bad_status, 400)
        self.assertEqual(status, 200)
        book = json.loads(body)["book"]
        self.assertEqual([level["price"] for level in book["asks"]], [0.41, 0.45])
        self.assertEqual([level["price"] for level in book["bids"]], [0.39, 0.38])
        self.assertNotIn("owner", book)
        self.assertEqual(seen, [server.POLYMARKET_CLOB_BOOK_URL + "?token_id=12345"])

    def test_training_endpoints(self) -> None:
        seen = []

        def fake(url: str, timeout: float = 8.0) -> object:
            seen.append(url)
            if "prices-history" in url:
                return {"history": [{"t": 100, "p": 0.4}, {"t": "bad"}, {"t": 200, "p": "0.6"}]}
            return [{"id": "7", "question": "Done?", "closed": True, "outcomes": '["Yes","No"]', "outcomePrices": '["1","0"]', "clobTokenIds": '["1","2"]', "secret": 1}]

        original = server._http_get_json
        server._http_get_json = fake
        try:
            status, body, _ = self.get("/api/polymarket/resolved?limit=5&offset=10")
            hist_status, hist_body, _ = self.get("/api/polymarket/history?token_id=1&fidelity=60")
            bad_status, _, _ = self.get("/api/polymarket/history?token_id=abc")
        finally:
            server._http_get_json = original
        self.assertEqual(status, 200)
        market = json.loads(body)["markets"][0]
        self.assertEqual(market["clobTokenIds"], '["1","2"]')
        self.assertNotIn("secret", market)
        self.assertIn("closed=true", seen[0])
        self.assertIn("offset=10", seen[0])
        self.assertEqual(hist_status, 200)
        self.assertEqual(json.loads(hist_body)["history"], [{"t": 100, "p": 0.4}, {"t": 200, "p": 0.6}])
        self.assertIn("market=1", seen[1])
        self.assertIn("fidelity=60", seen[1])
        self.assertEqual(bad_status, 400)

    def test_upstream_responses_are_cached_but_errors_are_not(self) -> None:
        calls = []
        original = server._http_get_json

        def flaky(url: str, timeout: float = 8.0) -> object:
            calls.append(url)
            if len(calls) == 1:
                raise urllib.error.URLError("temporary")
            return {"id": "9", "question": "Q?", "outcomes": '["Yes","No"]', "outcomePrices": '["0.5","0.5"]'}

        server._http_get_json = flaky
        try:
            first, _, _ = self.get("/api/polymarket/market?id=9")
            second, _, _ = self.get("/api/polymarket/market?id=9")
            third, _, _ = self.get("/api/polymarket/market?id=9")
        finally:
            server._http_get_json = original
        self.assertEqual((first, second, third), (502, 200, 200))
        self.assertEqual(len(calls), 2, "error not cached, success served from cache")
        self.assertEqual(server.cache_stats["hits"], 1)

    def test_gzip_when_accepted(self) -> None:
        request = urllib.request.Request(self.base + "/", headers={"Accept-Encoding": "gzip"})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.headers["Content-Encoding"], "gzip")


if __name__ == "__main__":
    unittest.main()
