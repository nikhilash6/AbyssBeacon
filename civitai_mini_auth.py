"""Small, bounded anonymous CivitAI mini-version authentication lookups.

This is *advisory* metadata: success never bypasses the actual downloader's
content validation.  We only request CivitAI's documented fixed-origin mini
endpoint; the UI never supplies a URL or an API credential to this client.
"""
import threading
import time

import requests

_POSITIVE_TTL = 6 * 60 * 60
_UNKNOWN_TTL = 5 * 60
_MIN_SPACING = 0.85


class MiniAuthCache:
    def __init__(self, http_get=None, clock=None):
        self._http_get = http_get or requests.get
        self._clock = clock or time.monotonic
        self._values = {}
        self._lock = threading.Lock()
        self._busy = False
        self._next_request_at = 0.0

    def peek(self, version_id):
        try:
            key = int(version_id)
        except (ValueError, TypeError):
            return None
        with self._lock:
            record = self._values.get(key)
            if record and record[1] > self._clock():
                return record[0]
        return None

    def check(self, version_id):
        try:
            version_id = int(version_id)
        except (ValueError, TypeError):
            return {"result": "unknown", "require_auth": None}
        if version_id <= 0 or version_id > 9999999999:
            return {"result": "unknown", "require_auth": None}

        with self._lock:
            now = self._clock()
            cached = self._values.get(version_id)
            if cached and cached[1] > now:
                return {"result": "known" if cached[0] is not None else "unknown",
                        "require_auth": cached[0], "cached": True}
            if self._busy or now < self._next_request_at:
                return {"result": "retry", "require_auth": None, "retry_after_ms": 1100}
            self._busy = True
            self._next_request_at = now + _MIN_SPACING

        value = None
        try:
            response = self._http_get(
                f"https://civitai.com/api/v1/model-versions/mini/{version_id}",
                timeout=(3, 7),
                allow_redirects=False,
                headers={"Accept": "application/json", "User-Agent": "AbyssBeacon/2.0"},
            )
            content_type = str(response.headers.get("Content-Type", "")).lower()
            if response.status_code == 200 and "json" in content_type:
                data = response.json()
                if isinstance(data, dict) and type(data.get("requireAuth")) is bool:
                    value = data["requireAuth"]
        except (requests.RequestException, ValueError, TypeError):
            pass
        finally:
            with self._lock:
                now = self._clock()
                self._values[version_id] = (value, now + (_POSITIVE_TTL if value is not None else _UNKNOWN_TTL))
                self._next_request_at = max(self._next_request_at, now + _MIN_SPACING)
                self._busy = False
        return {"result": "known" if value is not None else "unknown", "require_auth": value,
                "cached": False}


cache = MiniAuthCache()


def cached_require_auth(version_id):
    return cache.peek(version_id)
