"""Command-line entry point for the crawler and question-bank builder."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

from . import (
    accounts as accounts_mod,
    auth as auth_mod,
    config,
    seed as seed_mod,
    db,
    discover,
    enrich as enrich_mod,
    generate as generate_mod,
    history as history_mod,
    ingest as ingest_mod,
    pipeline,
    tagging,
)
from .fetch import Fetcher

app = typer.Typer(
    add_completion=False,
    help="Build and maintain the History Bee/Bowl question bank.",
    no_args_is_help=True,
)
console = Console()


# Commands that may run before an admin exists. `admin` is the bootstrap
# itself; `init` only creates an empty database. Everything else is gated.
_BOOTSTRAP_COMMANDS = {"admin", "init"}


@app.callback()
def _require_admin(
    ctx: typer.Context,
    as_admin: Optional[str] = typer.Option(
        None, "--as", metavar="EMAIL",
        help="Admin to run as. Defaults to $BEE_ADMIN_EMAIL; prompts otherwise.",
    ),
) -> None:
    """Every command runs as an admin.

    The password is read from $BEE_ADMIN_PASSWORD or prompted for — never
    accepted as a flag, which would put it in shell history and in `ps`.
    """
    command = ctx.invoked_subcommand
    if command is None:
        return

    with db.session() as conn:
        bootstrapped = auth_mod.any_admin_has_password(conn)

        # A fresh install has no admin to authenticate against; the bootstrap
        # commands are how the first one gets made. Once one exists with a
        # password, even those require signing in — otherwise anyone with a
        # shell could re-run `admin --reset` and take the install over.
        if not bootstrapped and command in _BOOTSTRAP_COMMANDS:
            console.print("[dim]No admin account yet — running unauthenticated.[/]")
            return

        try:
            email, password = auth_mod.resolve_credentials(
                as_admin, None, prompt=typer.prompt
            )
            name = auth_mod.verify_admin(conn, email, password)
        except auth_mod.AuthError as error:
            console.print(f"[red]{error}[/]")
            raise typer.Exit(code=1)
        except (EOFError, typer.Abort):
            console.print("[red]Cancelled.[/]")
            raise typer.Exit(code=1)

    console.print(f"[dim]Running as {name} <{email}>[/]")


def _event(kind: str, url: str, detail: str = "") -> None:
    colors = {"ok": "green", "fail": "red", "empty": "yellow"}
    marks = {"ok": "OK", "fail": "!!", "empty": "--"}
    color = colors.get(kind, "white")
    console.print(f"[{color}]{marks.get(kind, '..'):>2}[/] {url[:96]} [dim]{detail}[/]")


@app.command()
def init() -> None:
    """Create the database and apply the shared schema."""
    config.ensure_dirs()
    with db.session() as conn:
        n = conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0]
    console.print(f"[green]Database ready[/] at {config.DB_PATH} ({n} tags seeded)")


@app.command()
def crawl(
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Print the fetch plan (robots + delays) and exit."
    ),
    include_reference: bool = typer.Option(
        False, "--include-reference", help="Also crawl the general-history reference sites."
    ),
    offline: bool = typer.Option(
        False, "--offline", help="Use only the local cache; make no network requests."
    ),
    max_depth: int = typer.Option(config.MAX_DEPTH, help="Link-following depth from each seed."),
    max_pages: int = typer.Option(config.MAX_PAGES, help="Hard cap on pages fetched."),
    resume: bool = typer.Option(
        False, "--resume", help="Also queue URLs a previous crawl discovered but never fetched."
    ),
    url: Optional[list[str]] = typer.Option(None, "--url", help="Crawl these URLs instead of the seeds."),
) -> None:
    """Fetch the seed pages and everything they link to."""
    config.ensure_dirs()
    seeds = list(url) if url else list(config.SEED_URLS)
    if include_reference and not url:
        seeds += config.REFERENCE_SEEDS

    with Fetcher(offline=offline) as fetcher:
        if dry_run:
            table = Table(title="Crawl plan", show_lines=False)
            table.add_column("URL", overflow="fold")
            table.add_column("Allowed")
            table.add_column("Delay", justify="right")
            table.add_column("ai-train")
            table.add_column("Note", overflow="fold")
            for entry in discover.plan(seeds, fetcher):
                table.add_row(
                    entry.url,
                    "[green]yes[/]" if entry.allowed else "[red]no[/]",
                    f"{entry.crawl_delay:.0f}s",
                    "yes" if entry.ai_train_ok else "[yellow]no[/]",
                    entry.reason or "",
                )
            console.print(table)
            console.print(
                "[dim]Disallowed paths are skipped, never retried under a different "
                "user agent. 'ai-train: no' sources are used for reference only.[/]"
            )
            return

        with db.session() as conn:
            counts = discover.crawl(
                conn, fetcher, seeds, max_depth=max_depth, max_pages=max_pages,
                resume=resume, on_event=_event
            )
    console.print(f"[bold]crawl:[/] {counts}")


@app.command()
def extract() -> None:
    """Extract text from every fetched document."""
    with db.session() as conn:
        counts = discover.extract_all(conn, on_event=_event)
    console.print(f"[bold]extract:[/] {counts}")


@app.command()
def parse(
    reparse: bool = typer.Option(
        False,
        "--reparse",
        help="Also re-run already-parsed sources (use after a parser fix). "
        "Adds only what dedup lets through; nothing is deleted.",
    ),
) -> None:
    """Parse tossups and MCQs out of extracted text."""
    with db.session() as conn:
        if reparse:
            n = pipeline.reset_parsed(conn)
            console.print(f"[dim]re-queued {n} already-parsed source(s)[/]")
        counts = pipeline.parse_all(conn, on_event=_event)
    console.print(f"[bold]parse:[/] {counts}")


@app.command()
def tag() -> None:
    """Apply keyword categories to anything still untagged (no API key needed)."""
    with db.session() as conn:
        questions = tagging.tag_untagged(conn)
        sources = tagging.tag_sources(conn)
    console.print(f"[bold]tag:[/] {questions} question(s), {sources} source(s)")


@app.command()
def enrich(
    limit: Optional[int] = typer.Option(None, help="Only enrich this many questions."),
    batch_size: int = typer.Option(500, help="Questions per Batch API submission."),
) -> None:
    """Tag, grade, and explain questions with Claude (Batch API)."""
    if not config.has_api_key():
        console.print("[red]No ANTHROPIC_API_KEY set.[/] Enrichment needs a Claude credential.")
        raise typer.Exit(code=1)
    with db.session() as conn:
        pending = enrich_mod.pending_count(conn)
        console.print(f"{pending} question(s) awaiting enrichment")
        counts = enrich_mod.enrich(
            conn, limit=limit, batch_size=batch_size, on_event=lambda m: console.print(f"[dim]{m}[/]")
        )
    console.print(f"[bold]enrich:[/] {counts}")


@app.command()
def generate(
    tag: Optional[list[str]] = typer.Option(None, "--tag", help="Category to write about; repeatable."),
    difficulty: str = typer.Option("middle", help="elementary | middle | high | open"),
    fmt: str = typer.Option("tossup", "--format", help="tossup | mcq"),
    count: int = typer.Option(10, help="Questions per category."),
    no_batch: bool = typer.Option(
        False, "--no-batch",
        help="Run live concurrent calls instead of the Batch API: costs double, "
             "but is not stuck behind the batch queue.",
    ),
    concurrency: int = typer.Option(8, help="Parallel requests when --no-batch is set."),
    jobs: bool = typer.Option(False, "--jobs", help="Run pending jobs queued by the dashboard."),
    target: Optional[int] = typer.Option(
        None, "--target",
        help="Keep generating until this many GENERATED questions of this format exist.",
    ),
    from_study: bool = typer.Option(
        False, "--from-study-guides",
        help="Write one question per topic mined from the crawled official study guides.",
    ),
    include_prose: bool = typer.Option(
        False, "--include-prose",
        help="Also mine topics from study-guide prose, not just syllabus bullets (noisier).",
    ),
) -> None:
    """Generate new practice questions (marked origin='generated')."""
    if not config.has_api_key():
        console.print("[red]No ANTHROPIC_API_KEY set.[/] Generation needs a Claude credential.")
        raise typer.Exit(code=1)
    if fmt not in ("tossup", "mcq"):
        console.print("[red]--format must be 'tossup' or 'mcq'[/]")
        raise typer.Exit(code=2)

    with db.session() as conn:
        if jobs:
            n = generate_mod.run_pending_jobs(conn, on_event=lambda m: console.print(f"[dim]{m}[/]"))
            console.print(f"[bold]generate:[/] ran {n} queued job(s)")
            return
        if target and from_study:
            totals = generate_mod.generate_from_topics(
                conn,
                target=target,
                difficulty=difficulty,
                fmt=fmt,
                concurrency=concurrency,
                include_prose=include_prose,
                on_event=lambda m: console.print(f"[dim]{m}[/]"),
            )
            console.print(f"[bold]generate:[/] {totals}")
            return
        if target:
            totals = generate_mod.fill_to_target(
                conn,
                target=target,
                difficulty=difficulty,
                fmt=fmt,
                per_round=count,
                use_batch=not no_batch,
                concurrency=concurrency,
                on_event=lambda m: console.print(f"[dim]{m}[/]"),
            )
            console.print(f"[bold]generate:[/] {totals}")
            return
        counts = generate_mod.generate(
            conn,
            tags=list(tag) if tag else [None],
            difficulty=difficulty,
            fmt=fmt,
            per_tag=count,
            use_batch=not no_batch,
            concurrency=concurrency,
            on_event=lambda m: console.print(f"[dim]{m}[/]"),
        )
    console.print(f"[bold]generate:[/] {counts}")


@app.command()
def ingest(
    file: Optional[list[Path]] = typer.Option(None, "--file", help="Local PDF/DOCX/TXT to add."),
    url: Optional[list[str]] = typer.Option(None, "--url", help="Link to fetch and add."),
    inbox: bool = typer.Option(False, "--inbox", help="Drain uploads queued by the web app."),
) -> None:
    """Add user-supplied material to the question bank."""
    config.ensure_dirs()
    with db.session() as conn:
        if inbox or not (file or url):
            totals = ingest_mod.drain_inbox(conn, on_event=_event)
            console.print(f"[bold]inbox:[/] {totals}")
        for path in file or []:
            counts = ingest_mod.ingest_file(conn, path)
            _event("ok", str(path), str(counts))
        if url:
            with Fetcher() as fetcher:
                for u in url:
                    try:
                        counts = ingest_mod.ingest_url(conn, u, fetcher)
                        _event("ok", u, str(counts))
                    except Exception as exc:
                        _event("fail", u, str(exc))


@app.command()
def redifficulty() -> None:
    """Recompute difficulty levels from source file names (no re-parse needed)."""
    with db.session() as conn:
        counts = pipeline.redifficulty(conn)
    console.print(f"[bold]redifficulty:[/] {counts}")


@app.command()
def reindex() -> None:
    """Rebuild the full-text index (run this if dedup reports FTS corruption)."""
    with db.session() as conn:
        n = db.rebuild_fts(conn)
    console.print(f"[green]Rebuilt full-text index[/] over {n} question(s)")


@app.command()
def history(
    restore: bool = typer.Option(
        False, "--restore", help="Replay the journal into the database."
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Report what --restore would add, changing nothing."
    ),
    path: Optional[Path] = typer.Option(
        None, "--path", help="Journal file (defaults to data/history.jsonl)."
    ),
) -> None:
    """Inspect or restore practice history from the append-only journal.

    The web app mirrors every session and attempt to `data/history.jsonl`, so
    practice survives a lost or rebuilt `bee.db`. Restore is idempotent.
    """
    journal = path or history_mod.HISTORY_PATH
    counts = history_mod.journal_stats(journal)

    with db.session() as conn:
        in_db = {
            "sessions": conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0],
            "attempts": conn.execute("SELECT COUNT(*) FROM attempts").fetchone()[0],
        }

        console.print(f"\n[bold]Journal[/]  {journal}")
        if not journal.exists():
            console.print("  [yellow]not found[/] — no practice recorded yet\n")
            return
        console.print(f"  sessions  {counts['sessions']}")
        console.print(f"  attempts  {counts['attempts']}")
        if counts["malformed"]:
            console.print(f"  [yellow]malformed[/] {counts['malformed']}")

        console.print("\n[bold]Database[/]")
        console.print(f"  sessions  {in_db['sessions']}")
        console.print(f"  attempts  {in_db['attempts']}")

        profiles = conn.execute(
            """SELECT u.name,
                      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
                      (SELECT COUNT(*) FROM attempts a JOIN sessions s ON s.id = a.session_id
                       WHERE s.user_id = u.id) AS attempts
               FROM users u ORDER BY u.id"""
        ).fetchall()
        if profiles:
            console.print("\n[bold]Profiles[/]")
            for row in profiles:
                console.print(
                    f"  {row['name'][:24]:<24} {row['sessions']} session(s), "
                    f"{row['attempts']} attempt(s)"
                )

        if not (restore or dry_run):
            missing = counts["attempts"] - in_db["attempts"]
            if missing > 0:
                console.print(
                    f"\n[yellow]{missing} attempt(s) in the journal are not in the database.[/]"
                    "\nRun [bold]history --restore[/] to put them back.\n"
                )
            else:
                console.print("\n[green]Database is up to date with the journal.[/]\n")
            return

        report = history_mod.restore(conn, journal, dry_run=dry_run)

    verb = "would add" if dry_run else "added"
    console.print(f"\n[bold]Restore[/] ({'dry run' if dry_run else 'applied'})")
    if report.users_added:
        console.print(f"  profiles  {verb} {report.users_added}")
    console.print(f"  sessions  {verb} {report.sessions_added}, already present {report.sessions_skipped}")
    console.print(f"  attempts  {verb} {report.attempts_added}, already present {report.attempts_skipped}")
    if report.ended:
        console.print(f"  closed    {report.ended} session(s)")
    if report.review_queued:
        console.print(f"  review    re-queued {report.review_queued} missed question(s)")
    if report.orphan_attempts:
        console.print(
            f"  [yellow]skipped[/]   {report.orphan_attempts} attempt(s) whose session or "
            "question is no longer in the database"
        )
    if report.malformed_lines:
        console.print(f"  [yellow]malformed[/] {report.malformed_lines} line(s)")
    for error in report.errors:
        console.print(f"  [red]{error}[/]")
    console.print()


@app.command()
def admin(
    email: str = typer.Option(..., "--email", help="The admin's email address."),
    name: str = typer.Option("Adam", "--name", help="Display name."),
    reset: bool = typer.Option(
        False, "--reset", help="Forget the current password and issue a fresh link."
    ),
    site: Optional[str] = typer.Option(
        None, "--site", help="Base URL for the printed link (default http://localhost:3000)."
    ),
) -> None:
    """Make an account the admin and print a link for it to set a password.

    The web app is closed to anyone not signed in, so the first admin has to be
    created here. No password is ever set for someone else — this only issues
    the one-time link through which they choose their own.
    """
    base = (site or os.environ.get("BEE_SITE_URL") or "http://localhost:3000").rstrip("/")
    with db.session() as conn:
        user_id, token, created = accounts_mod.ensure_admin(conn, name, email)
        if reset:
            accounts_mod.clear_password(conn, user_id)
            token = accounts_mod.issue_set_password_token(conn, user_id)
        attempts = conn.execute(
            """SELECT COUNT(*) FROM attempts a JOIN sessions s ON s.id = a.session_id
               WHERE s.user_id = ?""",
            (user_id,),
        ).fetchone()[0]

    console.print(
        f"\n[bold]{'Created' if created else 'Updated'}[/] admin "
        f"[honey]{name}[/] <{email}> (account {user_id})"
    )
    if attempts:
        console.print(f"  keeps {attempts} existing practice attempt(s)")
    console.print("\n[bold]Set a password with this link[/] (single use, 48 hours):")
    console.print(f"  [green]{base}/set-password/{token}[/]\n")


@app.command()
def seed(
    output: Path = typer.Option(
        Path("/data/seed.db"), "--output", help="Where to write the snapshot."
    ),
    accounts: bool = typer.Option(
        True, "--accounts/--no-accounts",
        help="Include accounts and their password hashes. On by default.",
    ),
    texts: bool = typer.Option(
        True, "--texts/--no-texts",
        help="Include extracted source text and quarantine. Needed only for "
             "`parse --reparse`; dropping them makes the image much smaller.",
    ),
) -> None:
    """Build the database that gets baked into the image.

    The Dockerfile copies the result to /opt/bee/seed.db, and a container with
    an empty data volume installs it on first boot.
    """
    summary = seed_mod.build(
        config.DB_PATH, output, accounts=accounts, texts=texts
    )
    console.print(f"\n[bold]Wrote[/] {output}  ({summary['bytes'] / 1e6:.1f} MB)")
    console.print(f"  questions {summary['questions']}")
    console.print(f"  accounts  {summary['accounts']}")
    console.print(f"  attempts  {summary['attempts']}")
    if summary["with_credentials"]:
        console.print(
            "\n[yellow]This snapshot contains password hashes and email "
            "addresses.[/]\n  Anyone who can pull the image can read them — "
            "do not push it to a public registry."
        )
    console.print()


@app.command()
def stats() -> None:
    """Report what is in the bank and what failed along the way."""
    with db.session() as conn:
        s = db.stats(conn)

    console.print(f"\n[bold]Sources[/]  {s['sources_total']} total")
    for status, n in sorted(s["sources_by_status"].items(), key=lambda kv: -kv[1]):
        color = "red" if status in ("error", "robots_denied") else "white"
        console.print(f"  [{color}]{status:<16}[/] {n}")
    console.print("  [dim]by kind:[/] " + ", ".join(f"{k}={v}" for k, v in s["sources_by_kind"].items()))

    console.print(f"\n[bold]Questions[/]  {s['questions_total']} total")
    for key, n in sorted(s["questions_by_type_origin"].items()):
        console.print(f"  {key:<20} {n}")
    console.print(f"  enriched             {s['questions_enriched']}")
    console.print(f"  [yellow]untagged[/]             {s['questions_untagged']}")
    console.print(f"  [yellow]quarantined[/]          {s['quarantined']}  [dim](failed to parse; kept for review)[/]")

    if s["top_tags"]:
        console.print("\n[bold]Top categories[/]")
        for name, n in s["top_tags"]:
            console.print(f"  {name:<24} {n}")

    console.print(f"\n[bold]Practice[/]  {s['attempts']} attempt(s) recorded\n")


@app.command()
def quarantine(limit: int = typer.Option(10, help="How many entries to show.")) -> None:
    """Show text that looked like a question but failed to parse."""
    with db.session() as conn:
        rows = conn.execute(
            """
            SELECT q.reason, q.raw_text, s.url
            FROM quarantine q LEFT JOIN sources s ON s.id = q.source_id
            ORDER BY q.id DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
    if not rows:
        console.print("[green]Nothing quarantined.[/]")
        return
    for row in rows:
        console.print(f"\n[yellow]{row['reason']}[/] [dim]{row['url'] or 'upload'}[/]")
        console.print(f"[dim]{row['raw_text'][:400]}[/]")


@app.command()
def build(
    include_reference: bool = typer.Option(False, "--include-reference"),
    skip_llm: bool = typer.Option(False, "--skip-llm", help="Crawl and parse only."),
) -> None:
    """Run the whole pipeline: crawl -> extract -> parse -> enrich."""
    crawl(dry_run=False, include_reference=include_reference, offline=False,
          max_depth=config.MAX_DEPTH, max_pages=config.MAX_PAGES, resume=True, url=None)
    extract()
    parse()
    tag()
    if not skip_llm and config.has_api_key():
        enrich(limit=None, batch_size=500)
    elif not skip_llm:
        console.print(
            "[yellow]Skipping Claude enrichment: no ANTHROPIC_API_KEY set.[/] "
            "Questions carry keyword categories; explanations are unavailable."
        )
    stats()


if __name__ == "__main__":
    app()
