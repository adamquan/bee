"""Polite HTTP fetching: robots.txt, per-host rate limits, and a disk cache.

Every network read in the crawler goes through `Fetcher`. It refuses anything
robots.txt disallows for our user agent, waits out each host's Crawl-delay, and
caches raw bytes so re-runs are offline. Blocked hosts are recorded and skipped
— the crawler never tries to work around an access control.
"""

from __future__ import annotations

import hashlib
import time
import urllib.robotparser
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import httpx

from . import config


@dataclass
class FetchResult:
    url: str
    ok: bool
    status: str  # 'fetched' | 'robots_denied' | 'error' | 'skipped'
    detail: str | None = None
    content: bytes | None = None
    content_type: str | None = None
    sha256: str | None = None
    cache_path: str | None = None
    from_cache: bool = False

    @property
    def size(self) -> int:
        return len(self.content or b"")


@dataclass
class HostPolicy:
    """robots.txt state for one host."""

    parser: urllib.robotparser.RobotFileParser | None
    crawl_delay: float
    # Cloudflare's managed robots.txt carries a `Content-Signal` line such as
    # `search=yes,ai-train=no,use=reference`. We surface `ai-train` so downstream
    # code never feeds that text to a model as training data.
    ai_train_ok: bool = True
    signal_note: str | None = None
    last_request: float = field(default=0.0)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _parse_content_signal(robots_text: str) -> tuple[bool, str | None]:
    """Read the `Content-Signal` directive, if the host publishes one."""
    for line in robots_text.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("content-signal:"):
            value = stripped.split(":", 1)[1].strip()
            ai_train_ok = "ai-train=no" not in value.replace(" ", "").lower()
            return ai_train_ok, value
    return True, None


class Fetcher:
    def __init__(
        self,
        *,
        cache_dir: Path | None = None,
        user_agent: str = config.USER_AGENT,
        default_delay: float = config.DEFAULT_CRAWL_DELAY,
        timeout: float = config.REQUEST_TIMEOUT,
        max_bytes: int = config.MAX_BYTES,
        offline: bool = False,
    ) -> None:
        self.cache_dir = Path(cache_dir or config.CACHE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.user_agent = user_agent
        self.default_delay = default_delay
        self.max_bytes = max_bytes
        self.offline = offline
        self._policies: dict[str, HostPolicy] = {}
        self._client = httpx.Client(
            headers={
                "User-Agent": user_agent,
                "Accept": "text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*",
            },
            timeout=timeout,
            follow_redirects=True,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Fetcher":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------- robots --

    def policy(self, host: str) -> HostPolicy:
        if host in self._policies:
            return self._policies[host]

        parser: urllib.robotparser.RobotFileParser | None = None
        delay = self.default_delay
        ai_train_ok = True
        note = None
        try:
            resp = self._client.get(f"https://{host}/robots.txt", timeout=20)
            if resp.status_code == 200:
                text = resp.text
                parser = urllib.robotparser.RobotFileParser()
                parser.parse(text.splitlines())
                declared = parser.crawl_delay(self.user_agent)
                if declared is not None:
                    delay = max(float(declared), 1.0)
                ai_train_ok, note = _parse_content_signal(text)
            # A missing or erroring robots.txt means "no rules published"; we
            # still apply the conservative default delay.
        except Exception as exc:  # network failure fetching robots
            note = f"robots.txt unavailable: {exc.__class__.__name__}"

        pol = HostPolicy(parser=parser, crawl_delay=delay, ai_train_ok=ai_train_ok, signal_note=note)
        self._policies[host] = pol
        return pol

    def allowed(self, url: str) -> tuple[bool, str | None]:
        host = urlparse(url).netloc
        pol = self.policy(host)
        if pol.parser is None:
            return True, None
        if pol.parser.can_fetch(self.user_agent, url):
            return True, None
        return False, f"robots.txt disallows {self.user_agent} for this path"

    def seconds_until_ready(self, host: str) -> float:
        """How long before this host may be hit again. 0 means now.

        Lets a scheduler work a different host during another's crawl-delay
        instead of idling — each host still sees exactly the rate it asked for.
        """
        pol = self.policy(host)
        if not pol.last_request:
            return 0.0
        remaining = pol.crawl_delay - (time.monotonic() - pol.last_request)
        return max(0.0, remaining)

    def _wait(self, host: str) -> None:
        remaining = self.seconds_until_ready(host)
        if remaining:
            time.sleep(remaining)
        self.policy(host).last_request = time.monotonic()

    # -------------------------------------------------------------- cache --

    def _cache_file(self, url: str) -> Path:
        # Key on the URL so a cached body can be found before any request.
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
        return self.cache_dir / digest[:2] / digest

    def cached(self, url: str) -> bytes | None:
        path = self._cache_file(url)
        return path.read_bytes() if path.exists() else None

    def _store(self, url: str, data: bytes) -> Path:
        path = self._cache_file(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    # -------------------------------------------------------------- fetch --

    def fetch(self, url: str, *, use_cache: bool = True) -> FetchResult:
        host = urlparse(url).netloc
        if not host:
            return FetchResult(url, False, "error", "malformed URL")

        if use_cache:
            cached = self.cached(url)
            if cached is not None:
                return FetchResult(
                    url,
                    True,
                    "fetched",
                    "served from cache",
                    content=cached,
                    content_type=None,
                    sha256=_sha256(cached),
                    cache_path=str(self._cache_file(url)),
                    from_cache=True,
                )

        if self.offline:
            return FetchResult(url, False, "skipped", "offline mode and not in cache")

        ok, reason = self.allowed(url)
        if not ok:
            return FetchResult(url, False, "robots_denied", reason)

        self._wait(host)
        try:
            resp = self._client.get(url)
        except httpx.HTTPError as exc:
            return FetchResult(url, False, "error", f"{exc.__class__.__name__}: {exc}")

        if resp.status_code >= 400:
            # 403 from a WAF is a "no" — record it and move on rather than
            # retrying with a disguised user agent.
            return FetchResult(url, False, "error", f"HTTP {resp.status_code}")

        data = resp.content
        if len(data) > self.max_bytes:
            return FetchResult(url, False, "skipped", f"body exceeds {self.max_bytes} bytes")

        path = self._store(url, data)
        return FetchResult(
            url,
            True,
            "fetched",
            None,
            content=data,
            content_type=resp.headers.get("content-type"),
            sha256=_sha256(data),
            cache_path=str(path),
        )
