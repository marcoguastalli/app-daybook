# app-daybook

Self-hosted, topic-centric personal note-taking app: one markdown file per
topic with dated entries inside it, a PostgreSQL index on top, and a daily
view answering "what did I write on date X across all topics?" as an index
query. The md files are the single source of truth — the DB is always
rebuildable from them.

## Setup

```bash
cp .env.example .env   # then set APP_PASSWORD, SESSION_SECRET, POSTGRES_PASSWORD, POSTGRES_DATA_DIR
mkdir -p data/topics
sudo chown -R "$(id -u)":1000 data/topics && chmod -R g+w data/topics  # Linux only
docker compose up --build
```

**On Linux, `data/topics` needs shared ownership.** Two parties write there:
the app container, which runs non-root as `bun` (uid/gid 1000) with a
read-only filesystem everywhere else, and you, editing topic files directly
with vim. Linux bind mounts pass host ownership straight through, so the
command above keeps the files yours while granting the container's group
write access — without it, either saving from the app or editing by hand
fails with a permission error. macOS Docker Desktop virtualizes ownership,
so the step is unnecessary (and harmless) there.

The app listens on `http://localhost:7777`.

**Ports:** only `7777` (app) is published by default, bound to `0.0.0.0` —
reachable from your LAN/Tailscale as soon as your host firewall allows
incoming connections to Docker, nothing else to configure. `postgres` has no
host port at all. `7778` (pgadmin) only opens with `--profile debug` below —
don't forward it (or `5432`/`5050` from a shared instance, see "Shared
Postgres mode") beyond your LAN; they give raw DB/admin access with whatever
dev password is in `.env`.

pgadmin is optional and off by default: it is declared under the `debug`
compose profile, so a plain `docker compose up` never starts it. To opt in
for a debugging session:

```bash
docker compose --profile debug up     # also starts pgadmin on http://localhost:7778
docker compose --profile debug down   # stop everything including pgadmin
```

Log in with `PGADMIN_DEFAULT_EMAIL` / `PGADMIN_DEFAULT_PASSWORD` from `.env`,
then connect to host `postgres` (the DB is only reachable inside the Docker
network — it exposes no host port).

### Shared Postgres mode

Instead of this repo's own postgres, you can point the app at a single
Postgres/pgAdmin instance shared across multiple projects on the same
machine — see `my_docker/postgres/src/v1`. One-time setup: create this app's
database on the shared instance (it runs migrations itself on startup, so an
empty database is enough):

```bash
docker exec -it postgres psql -U postgres -c "CREATE DATABASE daybook;"
```

Then, instead of `docker compose up`:

```bash
docker compose -f docker-compose.yml -f docker-compose.shared-db.yml up app --no-deps
```

`--no-deps` is required — otherwise Compose still starts this repo's own
`postgres`. Set `SHARED_POSTGRES_*` in `.env` if your shared instance's
credentials or database name differ from the defaults (see `.env.example`).

## Development

```bash
bun install
bun test          # unit tests — pure functions, no infra needed
bun run build     # build the frontend (Vite)
bun run dev       # run the server with watch mode (needs postgres + .env)
```

### Backup

**Backing up `data/topics/` is the whole backup.** The markdown files are the
single source of truth; PostgreSQL only holds a derived index that is always
rebuildable — drop the database, restart (the schema is applied at startup),
and click Reindex in `/admin`. So a plain file copy is a complete backup:

```bash
tar czf daybook-$(date +%F).tar.gz data/topics/
```

The files stay useful without the app: plain markdown, readable in any
editor, one file per topic.

### Integration tests

Integration tests exercise the indexer against a real Postgres. They run
against a standalone, ephemeral test database — separate from the dev/prod
stack in `docker-compose.yml`, so nothing here ever touches real notes data:

```bash
cp .env.test.example .env.test    # once; fixed test-only credentials
docker compose -f docker-compose.test.yml up -d
bun run test:integration
docker compose -f docker-compose.test.yml down
```

The test Postgres stores its data on tmpfs, so every `up` starts from an
empty DB.

### End-to-end tests

Playwright drives a real browser against the running production stack
(including container-hardening assertions), so bring the stack up first:

```bash
docker compose up -d --build
bun run test:e2e
```

Tests create `e2e-*` topics in `data/topics/` and clean them up afterwards.

## API usage

Auth is session-cookie based (no API key), so start with the cookie-jar
flow: log in with `-c` to save the cookie, then pass `-b` on every
authenticated call. All examples use placeholder values.

```bash
# login — saves the session cookie to cookies.txt
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"password":"changeme"}' http://localhost:7777/api/auth/login

# health (unauthenticated, used by the Docker healthcheck)
curl http://localhost:7777/health

# list topics (slug, title, entry count, last entry date, validity)
curl -b cookies.txt http://localhost:7777/api/topics

# full topic: description, entries (descending), entry-precise backlinks
curl -b cookies.txt http://localhost:7777/api/topics/bitcoin-node

# create an entry — creates the topic file if missing; timestamp is
# server-side; responds with the natural key { slug, date, time }
curl -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"topicTitle":"Bitcoin Node","date":"2026-08-06","content":"upgraded to core 27, see [[Tailscale]]"}' \
  http://localhost:7777/api/entries

# edit one entry, addressed by natural key (slug, date, time);
# time is HH:MM, or the literal - for timestamp-less external entries.
# 409 = file changed on disk (reindex first) or duplicate headings.
curl -b cookies.txt -X PUT -H 'Content-Type: application/json' \
  -d '{"content":"rewritten content"}' \
  http://localhost:7777/api/topics/bitcoin-node/entries/2026-08-06/14:30

# delete one entry (same 409 rules; empty headings are cleaned up,
# the topic file itself is never deleted)
curl -b cookies.txt -X DELETE \
  http://localhost:7777/api/topics/bitcoin-node/entries/2026-08-06/14:30

# daily view: all entries of a date across topics
curl -b cookies.txt http://localhost:7777/api/days/2026-08-06

# search: fuzzy topic titles + full-text content, Google-like syntax
# ("exact phrase", -exclude, OR), highlighted snippets
curl -b cookies.txt 'http://localhost:7777/api/search?q=bitcoin%20-legacy'

# topic title autocomplete (typo-tolerant, accent-insensitive)
curl -b cookies.txt 'http://localhost:7777/api/autocomplete/topics?q=bitcoi'

# full rescan of the topics directory (rebuilds the whole index)
curl -b cookies.txt -X POST http://localhost:7777/api/admin/reindex

# admin view data: last reindex stats, index counts, invalid files
curl -b cookies.txt http://localhost:7777/api/admin/status

# logout (stateless sessions: clears the browser/jar cookie)
curl -b cookies.txt -X POST http://localhost:7777/api/auth/logout
```

Interactive docs: Swagger UI at `http://localhost:7777/docs` (behind the
session — log in via the SPA or the curl above first). The same API is
covered by the Bruno collection in `bruno/` (open the folder in Bruno, or
`cd bruno && bru run --env local --env-var appPassword=<your password>`);
any endpoint change updates OpenAPI, Bruno and this section together.
