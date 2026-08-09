"""Paths, seed URLs, and crawl policy constants."""

from __future__ import annotations

import os
from pathlib import Path

# ------------------------------------------------------------------- paths --
# DATA_DIR is the volume shared with the web container.
DATA_DIR = Path(os.environ.get("BEE_DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
DB_PATH = Path(os.environ.get("BEE_DB_PATH", DATA_DIR / "bee.db"))
CACHE_DIR = Path(os.environ.get("BEE_CACHE_DIR", DATA_DIR / "cache"))
INBOX_DIR = Path(os.environ.get("BEE_INBOX_DIR", DATA_DIR / "inbox"))
# The database baked into the image. Outside DATA_DIR on purpose, so a volume
# mounted there cannot hide it.
SEED_DB_PATH = Path(os.environ.get("BEE_SEED_DB", "/opt/bee/seed.db"))
SCHEMA_PATH = Path(
    os.environ.get("BEE_SCHEMA_PATH", Path(__file__).resolve().parents[2] / "shared" / "schema.sql")
)

# ------------------------------------------------------------ crawl policy --
# Honest identification. We are a personal study tool, not a search engine or a
# training-data collector; sites that disallow us in robots.txt are skipped.
USER_AGENT = os.environ.get(
    "BEE_USER_AGENT",
    "HistoryBeeTrainer/0.1 (personal study tool; respects robots.txt)",
)

# Used only when a host's robots.txt specifies no Crawl-delay. Deliberately
# conservative — iacompetitions.com asks for 10s and we default to matching it.
DEFAULT_CRAWL_DELAY = float(os.environ.get("BEE_CRAWL_DELAY", "10"))
REQUEST_TIMEOUT = float(os.environ.get("BEE_REQUEST_TIMEOUT", "60"))
MAX_DEPTH = int(os.environ.get("BEE_MAX_DEPTH", "3"))
MAX_PAGES = int(os.environ.get("BEE_MAX_PAGES", "600"))
MAX_BYTES = int(os.environ.get("BEE_MAX_BYTES", str(64 * 1024 * 1024)))

# ------------------------------------------------------------------- seeds --
SEED_URLS: list[str] = [
    "https://iacompetitionsasia.com/history-bee-bowl-practice-materials/",
    "https://www.ihbbeurope.com/resources/",
    "https://www.historyolympiad.com/resources/",
    "https://www.iacompetitions.com/study-guides/",
    "https://quizbowlpackets.com/",
    "https://www.iacompetitions.com/resources-national-history-bee/",
    "https://www.iacompetitions.com/ems-national-history-bee-past-questions/",
    "https://www.iacompetitions.com/resources-national-history-bowl/",
    "https://www.iacompetitions.com/ems-national-history-bowl/",
    "https://www.iacompetitions.com/exams/",
    # Additional official divisions carrying their own past-question archives.
    "https://www.ihbbeurope.com/sample-questions/",
    "https://www.ihbbeurope.com/past-questions/",
    "https://ihbbcanada.com/about/resources",
    "https://iacompetitionsasia.com/past-questions/",
    "https://www.iacompetitions.com/us-geography-championships/",
    "https://www.iacompetitions.com/national-history-bee-online-regional-qualifying-exam/",
    # Quizbowl Packet Archive: history-subject sets. The archive's own terms
    # release these for study and practice; its Content-Signal says
    # `ai-train=no`, which the crawler records and honours.
    "https://quizbowlpackets.com/1588/",  # 2014 HSAPQ US History Bee Regionals
    "https://quizbowlpackets.com/1641/",  # 2012 HSAPQ History Bowl Regional C
    "https://ms.quizbowlpackets.com/",    # middle-school division
]

# Hosts we will follow links *into* even though they are not a seed host.
# These are document-hosting endpoints the seed pages link out to.
ALLOWED_OFFSITE_HOSTS: set[str] = {
    "docs.google.com",
    "drive.google.com",
    # The Quizbowl Packet Archive serves its listings and its PDFs from
    # different hosts; without the file host the listings are dead ends.
    "files.quizbowlpackets.com",
    "ms.quizbowlpackets.com",
    "quizbowlpackets.com",
}

# Reference-content hosts (bee.md "other useful websites"). Crawled only when
# explicitly requested via `crawl --include-reference`, since they are large.
REFERENCE_SEEDS: list[str] = [
    "https://www.worldhistory.org/",
    "https://millercenter.org/president",
    "https://www.britannica.com/History-Society",
]

# --------------------------------------------------------------- llm setup --
# Claude Opus 5 — used for tagging, explanations, generation, and the
# last-resort tier of answer judging.
MODEL = os.environ.get("BEE_MODEL", "claude-opus-5")


def has_api_key() -> bool:
    """True when an Anthropic credential is available in the environment."""
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def ensure_dirs() -> None:
    for d in (DATA_DIR, CACHE_DIR, INBOX_DIR):
        d.mkdir(parents=True, exist_ok=True)
