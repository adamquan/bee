# History Bee Trainer

Two applications for practising National History Bee / History Bowl and history
championship exams:

- **`crawler/`** — builds the question bank. Crawls the official past questions
  and study guides, extracts text from PDF/DOCX/Google Docs, parses pyramidal
  tossups and multiple-choice questions, then uses Claude to tag, grade, explain,
  and generate more.
- **`web/`** — the practice app. Buzzer tossups with staged clue reveal, spoken
  answers, and the 30-second rule; multiple-choice exams; a dashboard with weak-area
  analysis and a missed-question queue.

Both share one SQLite file in `data/` and both run in Docker on Windows, macOS,
or a cloud host.

---

## Quick start

```bash
# 1. Build the question bank (takes a while — robots.txt asks for a 10s delay)
docker compose run --rm crawler build

# 2. Start practising
docker compose up web        # http://localhost:3000
```

`ANTHROPIC_API_KEY` is optional. Without it the app still serves official
questions, runs both quiz modes, and grades answers offline; question
generation, explanations, and moderator-style judging of close answers are
switched off and the UI says so. Categories always work — questions get keyword
tags at parse time, which Claude enrichment later replaces.

Official tossups carry no explanation until you enrich them. That is a Batch API
job over the whole bank and costs real money — budget roughly **$50–70 for all
13,000** at Opus 5 batch rates. Do a slice first to see the shape of it:

```bash
docker compose run --rm crawler enrich --limit 200
```

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or put it in a .env file next to docker-compose.yml
```

---

## The crawler

Every command runs as an admin:

```bash
docker compose run --rm crawler <command>            # prompts for email + password
docker compose run --rm crawler --as you@example.com <command>
```

For unattended runs, pass the credentials through the environment — the
password is deliberately not accepted as a flag, which would put it in shell
history and in `ps`:

```bash
docker compose run --rm \
  -e BEE_ADMIN_EMAIL -e BEE_ADMIN_PASSWORD crawler build
```

It is the same account and the same password as the web app: one `users`
table, and the scrypt parameters in `crawler/beecrawl/auth.py` are pinned to
`web/lib/auth.ts` by a test, so a password set in the browser verifies here.

`init` and `admin` run unauthenticated **only while no admin has a password
yet** — that is how the first one gets made. From then on they are gated like
everything else, so nobody can re-run `admin --reset` to take the install over.

> **What this protects.** It stops a non-admin on the machine from running the
> crawler, and stops accidental invocation of commands that spend money on the
> API. It is *not* a boundary against someone who can read and write
> `data/bee.db` — they can edit the accounts table directly. Treat filesystem
> access to `data/` as equivalent to admin.

| Command | What it does |
| --- | --- |
| `crawl --dry-run` | Print the fetch plan — robots.txt verdict, crawl delay, and `ai-train` signal per host — without making a single content request. |
| `crawl` | Fetch the seed pages and the documents they link to, caching raw bytes in `data/cache/`. |
| `crawl --resume` | Also queue everything a previous crawl discovered but never fetched. Use this after an interrupted run or a `--max-pages` cap instead of re-walking the index pages. |
| `extract` | Pull plain text out of every fetched PDF, DOCX, and page. |
| `parse` | Turn that text into tossups and MCQs. |
| `parse --reparse` | Also re-run sources already parsed, to pick up what an older parser missed. Adds only what dedup lets through; deletes nothing. |
| `tag` | Keyword categories for anything untagged. No API key needed — this is what keeps category filtering and weak-area analysis working offline. |
| `enrich` | Claude assigns categories and difficulty, writes explanations, and adds accepted answer alternates, replacing the keyword tags. Uses the Batch API (half price). |
| `generate --tag "World Wars" --count 20` | Write new questions in the official pyramidal style, marked `origin='generated'`. |
| `generate --target 500` | Keep generating until that many **generated** questions of the chosen format exist. Counts generated questions only — a bank-wide target is already satisfied by the crawled corpus. |
| `generate --target 500 --from-study-guides` | Write one question per topic mined from the crawled official study guides. Fixing the answer up front keeps the set grounded in the syllabus and avoids re-generating answers the bank already has. |
| `generate ... --no-batch --concurrency 16` | Run live concurrent calls instead of the Batch API. Roughly double the cost, but not stuck behind the batch queue, which can sit for hours on a busy account. |
| `generate --jobs` | Run the generation jobs the dashboard queued. |
| `ingest --inbox` | Process files and links uploaded on the Library page. |
| `ingest --file x.pdf` / `--url ...` | Add material directly. |
| `stats` | What is in the bank, and what failed on the way in. |
| `quarantine` | Show text that looked like a question but would not parse. |
| `reindex` | Rebuild the full-text index. Run this if dedup starts reporting FTS corruption. |
| `history` | Compare the practice journal against the database. |
| `history --restore` | Replay the journal back into the database. Idempotent. |
| `seed` | Build `data/seed.db`, the database baked into the image. `--no-accounts` omits credentials. |
| `build` | `crawl` → `extract` → `parse` → `tag` → `enrich` → `stats`. |

> **Never mix host and container writers.** The two apps share a SQLite file
> over a Docker bind mount, and Docker Desktop's file sharing does not carry
> SQLite's WAL locking across the VM boundary. Running a host-side process
> (`npm run dev`, or the crawler from `crawler/.venv`) at the same time as a
> containerised one against the same `data/bee.db` loses writes and **can
> corrupt the FTS index** — the symptom is a hard crash with `fts5: corruption
> found` or exit code 138. Recover with `crawler reindex`.
>
> Container-to-container is safe: `docker compose run --rm crawler ...` alongside
> a running `web` container shares the file correctly. Host-to-host is safe too.
> Just don't mix.
>
> Running the crawler on the host *is* markedly faster — extraction reads
> hundreds of cached PDFs, and virtiofs makes that roughly 20× slower inside a
> container (1,200 documents in ~90 seconds on the host versus ~an hour in
> Docker). To do that, stop the web container first:
>
> ```bash
> docker compose down
> cd crawler && python3 -m venv .venv && .venv/bin/pip install -e .
> BEE_DATA_DIR=../data BEE_DB_PATH=../data/bee.db BEE_SCHEMA_PATH=../shared/schema.sql \
>   .venv/bin/python -m beecrawl.cli extract
> ```

### How it crawls

The official archive is **2012–2022**: IAC and IHBB both stopped publishing past
questions after 2023, apart from selected national championship exams. What is
still posted is substantial — a full crawl of the seed list pulls roughly **1,250
documents (about 570 PDFs and Word files)** across seven official sites:

| Source | Documents |
| --- | --- |
| `files.quizbowlpackets.com` (Quizbowl Packet Archive, history sets) | ~250 |
| `www.iacompetitions.com` (National History Bee & Bowl) | ~200 |
| `www.historyolympiad.com` (International History Olympiad) | ~150 |
| `www.ihbbeurope.com` (European Division) | ~120 |
| `ihbbcanada.com` (Canadian Division) | ~90 |
| `iacompetitionsasia.com` (Asia Division) | ~70 |
| `docs.google.com` (study guides published as Google Docs) | ~30 |

With the generated sets on top the bank holds about **25,500 questions**, every
one tagged into the category vocabulary:

| | Questions |
| --- | --- |
| Official tossups (crawled) | ~24,600 |
| Generated tossups | 574 |
| Generated multiple choice | 353 |
| Official multiple choice | 11 |

Generated questions all carry an explanation; crawled ones do not until enriched.

The official figure moves as `parse --reparse` picks up what earlier parser
versions missed. Three checks say whether the bank is in good shape, and all
three should hold after any reparse:

```bash
docker compose run --rm crawler reindex   # questions and FTS rows must match
docker compose run --rm crawler stats     # untagged should be 0
docker compose run --rm crawler parse --reparse   # a second run should add ~0
```

A reparse that keeps adding thousands means dedup is failing open — almost
always a damaged full-text index, since `find_near_duplicate` treats an FTS
error as "not a duplicate" rather than aborting a multi-hour parse. `reindex`
fixes it.
`hsquizbowl.org` returns 403 to any crawler and is skipped.

Roughly a third of what looks like a question is quarantined rather than
imported: geography- and science-bee items mixed into the same archives,
bonus parts, and scanned PDFs with no text layer. `crawler quarantine` shows a
sample with the reason for each.

Crawling is scoped to personal study and is deliberately conservative:

- `robots.txt` is fetched and honoured per host, including `Crawl-delay`
  (default 10s when a host doesn't specify one).
- The user agent identifies the tool honestly. A host that blocks us is
  recorded as `robots_denied` and skipped — never retried in disguise.
- Every response is cached on disk, so re-runs make no new requests.
- Hosts publishing `Content-Signal: ai-train=no` (quizbowlpackets.com does) are
  stored with `ai_train_ok = 0`, and their text is never sent to a model as
  source material for generation. It is used for reference and quizzing only.
- Documents are prioritised over navigation pages, so a page budget reaches the
  actual question sets.
- Hosts are worked round-robin: while one is inside its crawl-delay the crawler
  fetches from another rather than idling. Each host still sees exactly the rate
  it asked for, but a ten-host crawl finishes roughly ten times sooner.

### Adding more questions to an existing bank

Every stage is incremental, driven by a status ladder on each source:

```
pending ──crawl──▶ fetched ──extract──▶ extracted ──parse──▶ parsed
```

A command only picks up sources sitting at its own stage, so re-running one is
cheap and safe. That also means a source is mined exactly once — which is what
the two flags below are for.

**Sources still `pending`** were discovered by a previous crawl but never
fetched, usually because a `--max-pages` cap cut the run short. Work through
them with:

```bash
docker compose run --rm crawler crawl --resume --max-pages 1000
docker compose run --rm crawler extract
docker compose run --rm crawler parse
docker compose run --rm crawler tag
```

`--max-pages` defaults to 600, so raise it above the pending count or expect to
run the sequence twice. Pace is set by `robots.txt`: 10s per host, worked
round-robin, so the wall-clock is roughly *(pending on the busiest host) × 10s*
rather than the total. Crawling discovers more links as it goes, so the pending
count can rise before it falls.

**Sources already `parsed`** have given up their questions once. They are worth
revisiting after a parser fix — and this project has had several (hyphens lost
across line breaks, packet preambles bleeding into the first clue, `[10]` bonus
markers, PDF word-spacing). `--reparse` sends them back through:

```bash
docker compose run --rm crawler parse --reparse
```

It deletes nothing. Existing questions stay, the near-duplicate check drops
whatever the second pass finds again, and a source's quarantine entries are
replaced rather than stacked. Running it on the bank as it stood recovered
**406 questions** the parser had missed when those files were first read; a
second run immediately after added 2, which is the signal that the text is
exhausted.

Neither flag touches practice history.

### Generating from the study guides

`--from-study-guides` mines the syllabus bullets out of the crawled study guides
— the IHBB European, Canadian and Asia guides, the IHO Blitz guide and others —
and writes one question per topic.

This matters for more than grounding. Asking for "five tossups on the Ancient
World" makes the model reach for the same famous answers every time, and with
13,000 official questions already banked nearly all of them are rejected as
duplicates; yield fell to about 30%. Fixing the answer up front, from a topic
the official guides actually list, keeps the questions both on-syllabus and
varied.

```bash
docker compose run --rm crawler generate \
  --format tossup --difficulty middle --target 500 \
  --from-study-guides --no-batch --concurrency 16
```

Add `--include-prose` to also mine proper nouns from the guides' narrative text.
That roughly quadruples the topic pool but is noticeably noisier — it picks up
sentence fragments alongside real subjects — so it is off by default.

### Credentials

`ANTHROPIC_API_KEY` belongs in `.env` beside `docker-compose.yml` — that file is
gitignored, and compose reads it automatically. Don't put the key in
`docker-compose.yml` itself; that file is tracked, so the key would end up in
your git history.

```
ANTHROPIC_API_KEY=sk-ant-...
```

---

## The practice app

### Buzzer tossups

Clues reveal one at a time, hardest first, read aloud by the browser. Buzz with
**space** at any point: the reveal pauses, the microphone opens, and the clue
you buzzed on is recorded — so the dashboard can show *how early* you buzz, not
just whether you were right. If nobody buzzes, a **30-second** timer starts once
the giveaway finishes, then the answer and explanation appear. Any clues you
never heard are shown too, so the question always finishes.

Typed input sits alongside the microphone at all times, for Firefox (no speech
recognition), a denied mic permission, or a noisy room.

### Answer judging

Three tiers, cheapest first:

1. **Exact** — normalised comparison against the answer and its alternates.
2. **Token matching** — numeral folding and typo tolerance. Accepts "Mali" for
   *Mali Empire*, "Louis the 14th" for *Louis XIV*, "cuneform" for *Cuneiform*.
   Rejects "Louis XVI" for *Louis XIV*, because the regnal number is what
   identifies the answer.
3. **Claude** — only for genuinely close calls the first two tiers can't settle,
   and only if an API key is present. Otherwise the offline decision stands.

### Dashboard

Accuracy overall and per category, average buzz position, session history, and:

- **Weak areas** — categories below your own average with at least four
  attempts, each with a one-click drill, a count of unseen questions, and links
  to study guides the crawler actually fetched (real URLs, never model-invented).
- **Missed questions** — an SM-2-style queue that brings misses back on
  widening intervals. Answering correctly first time never schedules a review.
- **Generate more** — queues a Claude job for a weak category when the bank runs
  thin there; run `crawler generate --jobs` to process it.

### Accounts and sign-in

The site is closed. Every page and API redirects to `/login` without a session.

Anyone can request an account at `/register` with a name and email. It arrives
**pending**; an admin approves it from `/admin`. Approval issues a **single-use
link, valid 48 hours**, emailed to the registrant, through which they choose
their own password. No password is ever set for somebody else, and none is sent
by email.

**The first admin is created from the command line** — the web app cannot do
it, because every page of it requires being signed in already:

```bash
docker compose run --rm crawler admin --email you@example.com --name Adam
```

That prints a set-password link. It claims an existing account with that
address or display name, and otherwise the original profile — so practice
recorded before logins existed stays attached to a real person. `--reset`
forgets the current password and issues a fresh link, which is the way back in
if one is forgotten.

How it is built:

- **scrypt** for passwords, from `node:crypto` — a real key-derivation
  function, never a bare hash. Salted per account.
- **Server-side sessions.** The cookie is an opaque random id; the record lives
  in the database. A signed self-contained cookie could not be revoked, and
  declining an account has to cut its access at once — it does, mid-session.
- **Invite tokens are stored hashed**, so a leaked database cannot be used to
  claim an outstanding invite. Single use, and redeeming one voids the rest.
- **The same error for every failed sign-in**, whether the address is unknown,
  unapproved, or the password is simply wrong. Anything else is an
  account-enumeration oracle.
- **Rate limiting** on failed sign-ins, per address and per client, eight in
  fifteen minutes.
- Registration cannot set its own role or status; both are server-side.

The middleware is a gate, not the authorisation. It runs on the Edge runtime,
where it cannot open SQLite, so it only checks that a session cookie exists —
whether that cookie names a live, approved account is settled by the page or
route itself. A forged cookie gets past the gate and is then turned away.

#### Email

Set these to have invites actually sent:

```
BEE_SITE_URL=https://bee.example.com
SMTP_HOST=…  SMTP_PORT=587  SMTP_USER=…  SMTP_PASS=…  SMTP_FROM=…
```

Without them, approving still works: the message is written to
`data/outbox/` and the invite link is shown in the admin page for you to pass
on. Failing silently would leave a new member locked out with nothing to show
why.

### Profiles

Each account keeps its own practice. Everything that records what *you* did is
per account:

- the dashboard — accuracy, buzz position, sessions, weak areas, missed questions
- the review queue, so two people who miss different things drill different things
- "new questions first", counted per profile rather than globally
- clearing history, which only clears the profile you are on

The question bank, the Library, and the crawler are shared — those are about
the material, not the student.

An existing database is migrated on first start — accounts gain credentials, a
role, and an approval state, and everything already recorded stays where it is.
The migration is idempotent.

### Practice history

History lives in `data/bee.db` and survives restarts, rebuilds, and
`docker compose down` — `data/` is a bind mount, not a container volume.

It is also mirrored, as it happens, to an append-only `data/history.jsonl`:
one JSON object per session and per attempt. The question bank is reproducible
by re-running the crawler, but practice history is not, and it shares a
database file with the bank — so anything that damages or rebuilds `bee.db`
would otherwise take it along. Put it back with:

```bash
docker compose run --rm crawler history            # compare journal to database
docker compose run --rm crawler history --dry-run  # what a restore would add
docker compose run --rm crawler history --restore  # replay it
```

`history` also lists each profile's session and attempt counts. Journal entries
carry the profile that recorded them, and restore matches profiles **by name**,
creating one if it is missing — so a restore into a fresh database rebuilds the
profiles as well as their practice. Entries written before profiles existed
carry no name and land on **Student**, which is where the migration puts them
too.

Restore is idempotent, and safe to run against a database that already holds
newer practice. It never reuses the journal's row ids: a database whose history
was lost and then practised against again will have reissued them, so sessions
are matched on `started_at` + format + filters and attempts on session +
question + `created_at`. Attempts whose question is no longer in the bank are
reported rather than silently dropped, and a journal line truncated by a killed
process is counted, not fatal.

**Clearing it.** The dashboard has a *Clear history* button, behind a
confirmation that names what is about to go — how many attempts, across how
many sessions, and how many queued questions. The question bank is untouched.

Clearing archives the journal to `data/history-cleared-<timestamp>.jsonl`
rather than deleting it. Leaving it in place would let a later `--restore`
silently undo the clear; deleting it outright would make a mis-click
unrecoverable. So the clear is undoable:

```bash
docker compose run --rm crawler history --restore \
  --path data/history-cleared-2026-07-31T14-34-10-692Z.jsonl
```

If the journal cannot be archived the database is left alone — a wiped
database beside a live journal is the one state that would quietly come back.

The `review_queue` is not journalled — it is a function of the attempt
sequence, and a second copy of the app's SM-2 rules in the crawler would be two
implementations to drift apart. Restore reconstructs it instead: questions
whose most recent attempt was a miss are re-queued at a one-day interval. That
is deliberately not an exact replay — intervals restart rather than resuming —
and it self-corrects from the next answer onward, since the app runs the real
scheduler on every attempt. An entry that already exists is left untouched.

### Library

Upload PDFs, Word documents, or links. They queue in `data/inbox/` and go
through the same extract → parse → enrich pipeline as crawled material.

Below the uploader is every source in the bank — all 1,992 of them, 25 to a
page, filterable by host, type, and status, with a search over titles and URLs.
Each row links to the original and shows how many questions came out of it.
Filter state lives in the URL, so a view is shareable and the back button works.

Sources on hosts that publish `ai-train=no` are marked **reference only**. That
is derived per host rather than per row: the `ai_train_ok` column is only
written once a source has actually been fetched and its `Content-Signal` header
read, so a source still `pending` on a restricted host would otherwise look
unrestricted.

---

## Shipping the database inside the image

By default the image carries no data: `data/` is gitignored and excluded from
the build context, so a fresh deployment would have no questions and no
accounts. `crawler seed` bakes them in.

```bash
docker compose run --rm crawler seed     # writes data/seed.db
docker compose build                      # the Dockerfiles pick it up
```

The order matters — the build reads `data/seed.db`, so the seed has to exist
first. Then a container started against an empty volume comes up complete:

```
[bee] installed the bundled database (86503424 bytes) at /data/bee.db
```

**The seed lives at `/opt/bee/seed.db`, not `/data`.** Baking it straight to
`/data/bee.db` would work only until a volume was mounted there, at which point
the mount hides the baked file and the app comes up empty; and with no volume
at all, every attempt recorded after deployment would be lost on the next
restart. It is copied into place at boot instead, which populates a fresh volume
*and* keeps everything written afterwards. An existing database is never
overwritten.

| Flag | Effect |
| --- | --- |
| *(default)* | Questions, accounts, password hashes, and practice history. |
| `--no-accounts` | Questions only. No credentials, no emails, no history. |
| `--no-texts` | Drops extracted source text and quarantine — needed only for `parse --reparse`. Much smaller image. |

Live sessions, invite tokens, and the local upload queue are never included:
those cookies belong to browsers that will not exist, and a token in an image
is a credential in an image.

> **A seed built with accounts contains password hashes and email addresses.**
> Anyone who can pull the image can read them, and image layers are cached and
> shared far more freely than a data volume. Keep such an image in a private
> registry, or build with `--no-accounts` and bootstrap with `crawler admin` on
> the far side. The same applies to the question bank: it is other people's
> copyrighted material, and an image is a distribution channel.

Also set, for anything not on localhost:

```
BEE_SITE_URL=https://bee.example.com    # invite links point here
SMTP_HOST=… SMTP_PORT=587 SMTP_USER=… SMTP_PASS=… SMTP_FROM=…
```

---

## Deploying to Google Compute Engine

A VM with a persistent disk, not Cloud Run. Cloud Run's filesystem is
ephemeral — everything written after boot is lost when the instance goes away —
and its NFS mounts are `no-lock`, which corrupts SQLite rather than erroring.
A VM keeps the app exactly as it runs locally.

### 1. Create the disk and VM

First find the network. Many organisations enforce
`compute.skipDefaultNetworkCreation`, so the project has no network called
`default` and `gcloud` fails with *"The referenced network resource cannot be
found"*:

```bash
gcloud compute networks list
gcloud compute networks subnets list --filter="region:us-central1"
```

Use those names below — `default` only if it is genuinely there.

```bash
NETWORK=default          # or e.g. the one your project actually has
SUBNET=default
ZONE=us-central1-a

gcloud compute disks create bee-data --size=20GB --type=pd-balanced --zone=$ZONE

gcloud compute instances create bee \
  --zone=$ZONE --machine-type=e2-medium \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --disk=name=bee-data,device-name=bee-data,mode=rw,auto-delete=no \
  --network=$NETWORK --subnet=$SUBNET \
  --tags=bee-web \
  --scopes=cloud-platform \
  --metadata=bee-domain=bee.example.com \
  --metadata-from-file=startup-script=deploy/startup.sh

# --network matters here too: without it the rule lands on `default`, which
# may not exist. The target tag keeps it scoped to this VM rather than opening
# a port on everything in the network.
gcloud compute firewall-rules create bee-web \
  --network=$NETWORK --allow=tcp:80,tcp:443 \
  --source-ranges=0.0.0.0/0 --target-tags=bee-web
```

`e2-medium` (2 vCPU, 4GB) is sized for the Next build, which needs more than a
`micro` has. `--device-name=bee-data` matters: the startup script looks for
`/dev/disk/by-id/google-bee-data`.

### 2. Secrets

Nothing sensitive belongs in the repo or the image. The startup script reads
one secret and writes `.env`:

```bash
printf 'ANTHROPIC_API_KEY=sk-ant-...\nSMTP_HOST=...\nSMTP_USER=...\nSMTP_PASS=...\nSMTP_FROM=...\n' \
  | gcloud secrets create bee-env --data-file=-
gcloud secrets add-iam-policy-binding bee-env \
  --member="serviceAccount:$(gcloud compute instances describe bee --zone=us-central1-a \
      --format='value(serviceAccounts[0].email)')" \
  --role=roles/secretmanager.secretAccessor
```

### 3. DNS, then TLS happens by itself

Point an A record at the VM's external IP. Caddy obtains and renews the
certificate on first request — no cert files, no renewal cron. HTTPS is not
optional here: the session cookie is only marked `secure` when `BEE_SITE_URL`
is https, and invite links go out as absolute URLs.

### Reaching it

Get the address:

```bash
gcloud compute instances describe bee --zone=$ZONE \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

**DNS has to come first — the IP alone will not work.** Caddy serves one site,
the one named by `BEE_DOMAIN`, and redirects everything to HTTPS. A request to
the bare IP gets `308 -> https://<ip>/`, and there is no certificate for an IP,
so the browser stops there. Point an `A` record at the address and use the
hostname:

```bash
dig +short bee.example.com          # must return the VM's IP before this works
```

Caddy then requests a certificate on the first HTTPS request. Watch it happen:

```bash
gcloud compute ssh bee --zone=$ZONE --command \
  'sudo docker compose -f /opt/bee/app/docker-compose.yml \
     -f /opt/bee/app/deploy/docker-compose.prod.yml logs -f caddy'
```

`certificate obtained successfully` means you are done: open
`https://bee.example.com`, sign in, and the practice app is there.

If it never gets one, the cause is almost always that Let's Encrypt could not
reach port 80 for the challenge — check the firewall rule exists **on the right
network** and that the VM carries the `bee-web` tag.

#### Before DNS exists

To look at it before the record propagates, add a plaintext catch-all to
`deploy/Caddyfile` and restart Caddy:

```
http:// {
	reverse_proxy web:3000
}
```

`http://<ip>` then works. **Take it out once DNS is live** — it is a route to
the app that bypasses TLS, and the session cookie is not marked `secure` over
it.

### 4. Get the database there

The repo carries no data, so bring the question bank and accounts across:

```bash
docker compose down                                   # so nothing is mid-write
gcloud compute scp data/bee.db data/history.jsonl bee:/tmp/ --zone=us-central1-a
gcloud compute ssh bee --zone=us-central1-a --command \
  'sudo mv /tmp/bee.db /tmp/history.jsonl /opt/bee/data/ && sudo chown 10001:10001 /opt/bee/data/*'
```

Or start empty and bootstrap: `crawler admin --email you@example.com`, then run
a crawl on the VM. That is ~45 minutes of fetching plus the enrichment cost.

### 5. Running the crawler there

Same commands, on the VM:

```bash
gcloud compute ssh bee --zone=us-central1-a
cd /opt/bee/app
sudo docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml \
  run --rm crawler stats
```

It still asks for admin credentials. For unattended jobs pass
`BEE_ADMIN_EMAIL` / `BEE_ADMIN_PASSWORD`; a nightly `generate --jobs` fits a
systemd timer or a cron entry calling the same command.

The crawler is a batch job and the web app is a service — they share the disk,
never run at once against the same database from a host *and* a container, and
`docker compose run` is container-to-container, so it is safe alongside `web`.

### Updating

`git pull` and rebuild; the startup script does both on reboot:

```bash
cd /opt/bee/app && sudo git pull && \
  sudo docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

### What the overlay changes

`deploy/docker-compose.prod.yml` moves the data volume to `/opt/bee/data`,
stops the app publishing port 3000 (Caddy reaches it over the compose network,
so there is no plaintext route past TLS), and adds the proxy. Caddy forwards
`X-Forwarded-For`, which the login rate limiter keys on — without it every
request looks like one client and one person's failed logins would lock out
everybody.

---

## Local development

```bash
# crawler
cd crawler
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest            # parser tests
.venv/bin/python -m beecrawl.cli stats

# web
cd web
npm install
npm test                              # answer-judging tests
npm run dev                           # http://localhost:3000
```

Both read `BEE_DB_PATH` / `BEE_DATA_DIR` / `BEE_SCHEMA_PATH` if you want the
database somewhere other than `./data`.

---

## Layout

```
shared/schema.sql     one schema, applied by both apps
crawler/beecrawl/     fetch → extract → parse → enrich → generate
web/lib/              db, judging, selection, review scheduling, stats
web/app/              pages and API routes
data/                 bee.db, cache/, inbox/   (gitignored)
```

The database keeps `origin` on every question, so official and generated
questions are always distinguishable and can be practised separately.

---

## A note on the material

This is a study tool. Official questions remain the property of IAC, IHBB, and
the other publishers; the crawler caches them locally for one student's
practice and respects each site's stated crawling preferences. Don't
redistribute the contents of `data/`.
