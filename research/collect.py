"""Collect resolved Polymarket binary markets and their price histories (read-only).

Usage:  python research/collect.py data/dataset.json [MARKETS=6000] [SHIFT_DAYS=0]

SHIFT_DAYS moves the sampled days (1-5) to draw an independent replication sample.

Notes from running this against the live API:
  * Gamma pagination fails (HTTP 422) past roughly 1,000 rows, and `order=` combined with a
    date filter returns HTTP 500. So markets are sampled by *scheduled end date* in windows:
    one day every six days, going back from yesterday, up to 100 markets per window. That
    spreads the sample over about a year instead of the last few days.
  * CLOB prices-history ignores fidelity below ~12h when `interval=max` is used, and rejects
    explicit startTs/endTs ranges of 15 days or more. Each history is therefore the full life
    at 12h merged with the last 14 days before the end at 6h.
  * `endDate` (scheduled, known in advance) and `closedTime` (actual) are both kept: "by <date>"
    markets close early when the event happens, so horizons must count back from endDate and
    samples after closedTime must be dropped (see metyu-agent.js buildTrainingSamples).
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

GAMMA = "https://gamma-api.polymarket.com/markets"
HISTORY = "https://clob.polymarket.com/prices-history"
HEADERS = {"Accept": "application/json", "User-Agent": "practice-research/1.0"}


def get(url, tries=3):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code < 500 or attempt == tries - 1:
                raise
        except Exception:  # noqa: BLE001
            if attempt == tries - 1:
                raise
        time.sleep(1.5 * (attempt + 1))
    return None


def parse_list(value):
    if isinstance(value, list):
        return value
    try:
        return json.loads(value)
    except Exception:  # noqa: BLE001
        return []


def to_ts(value):
    if not value:
        return None
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00").replace(" ", "T")).timestamp())
    except ValueError:
        return None


def binary_resolved(raw):
    outcomes = [str(o) for o in parse_list(raw.get("outcomes"))]
    prices = [float(p) for p in parse_list(raw.get("outcomePrices")) if p not in (None, "")]
    tokens = [str(t) for t in parse_list(raw.get("clobTokenIds"))]
    if len(outcomes) != 2 or len(prices) != 2 or len(tokens) != 2:
        return None
    yes_index = next((i for i, name in enumerate(outcomes) if name.lower() == "yes"), 0)
    if prices[yes_index] >= 0.99:
        outcome = "YES"
    elif prices[yes_index] <= 0.01:
        outcome = "NO"
    else:
        return None      # closed but not cleanly settled (e.g. disputed)
    events = raw.get("events") or [{}]
    event = events[0] if isinstance(events[0], dict) else {}
    return {
        "id": str(raw.get("id")), "eventId": str(event.get("id") or raw.get("id")), "eventTitle": event.get("title"),
        "question": raw.get("question"), "slug": raw.get("slug"), "outcome": outcome, "yesToken": tokens[yes_index],
        "endDate": raw.get("endDate"), "closedTime": raw.get("closedTime"), "startDate": raw.get("startDate"),
        "volume": raw.get("volumeNum"), "negRisk": bool(raw.get("negRisk")),
        "feesEnabled": bool(raw.get("feesEnabled")), "takerBaseFee": raw.get("takerBaseFee"),
    }


def list_markets(target, shift_days=0):
    markets, seen = [], set()
    window_end = datetime.now(timezone.utc) - timedelta(days=1 + shift_days)
    for _ in range(200):
        if len(markets) >= target:
            break
        window_start = window_end - timedelta(days=1)
        query = urllib.parse.urlencode({"closed": "true", "limit": 100, "end_date_min": window_start.strftime("%Y-%m-%dT%H:%M:%SZ"), "end_date_max": window_end.strftime("%Y-%m-%dT%H:%M:%SZ")})
        page = get(f"{GAMMA}?{query}") or []
        added = 0
        for raw in page if isinstance(page, list) else []:
            market = binary_resolved(raw)
            if market and market["id"] not in seen:
                seen.add(market["id"])
                markets.append(market)
                added += 1
        print(f"window {window_start:%Y-%m-%d}: +{added} -> {len(markets)}", flush=True)
        window_end -= timedelta(days=6)
    return markets[:target]


def add_history(market):
    end = to_ts(market["endDate"]) or to_ts(market["closedTime"])
    last = min(x for x in (to_ts(market["closedTime"]), end) if x) if end else None
    points, errors = {}, []
    queries = [{"market": market["yesToken"], "interval": "max", "fidelity": 720}]
    if last:
        queries.append({"market": market["yesToken"], "startTs": last - 14 * 86400, "endTs": last + 3600, "fidelity": 360})
    for query in queries:
        try:
            for point in (get(f"{HISTORY}?{urllib.parse.urlencode(query)}") or {}).get("history", []):
                if "t" in point and "p" in point:
                    points[int(point["t"])] = float(point["p"])
        except Exception as error:  # noqa: BLE001
            errors.append(str(error)[:60])
    market["history"] = [{"t": t, "p": points[t]} for t in sorted(points)]
    if not points and errors:
        market["historyError"] = errors[-1]
    return market


def main():
    out = sys.argv[1]
    target = int(sys.argv[2]) if len(sys.argv) > 2 else 6000
    shift = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    markets = list_markets(target, shift)
    with ThreadPoolExecutor(max_workers=8) as pool:          # polite: at most 8 requests at once
        for done, _ in enumerate(pool.map(add_history, markets), 1):
            if done % 500 == 0:
                print(f"histories {done}/{len(markets)}", flush=True)
    with open(out, "w") as handle:
        json.dump(markets, handle)
    print("saved", len(markets), "markets;", sum(1 for m in markets if m["history"]), "with history;", len({m["eventId"] for m in markets}), "events")


if __name__ == "__main__":
    main()
