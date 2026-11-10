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

    def test_gzip_when_accepted(self) -> None:
        request = urllib.request.Request(self.base + "/", headers={"Accept-Encoding": "gzip"})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.headers["Content-Encoding"], "gzip")


if __name__ == "__main__":
    unittest.main()
