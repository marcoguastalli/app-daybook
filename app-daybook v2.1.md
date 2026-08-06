- APP-DAYBOOK
	- Context/Role
		- app-daybook is a self-hosted, open-source, personal note-taking app inspired by Logseq, but topic-centric instead of day-centric
		- in Logseq every day creates a new md file and the same topic gets fragmented across many daily files with no relation between them; app-daybook inverts the model: one md file per topic, dated entries inside it
		- killer feature: the daily view ("what did I write on date X across all topics?") is generated as an index query, never by duplicating or fragmenting content across files
		- runs in Docker on a personal home server, accessed via web browser
		- de facto the app consists of 4 parts:
			- markdown file storage: one `.md` file per topic, the single source of truth, stored on a bind-mounted volume and editable also externally (vim, VS Code, etc.)
			- indexer: parses the md files and keeps a PostgreSQL index of topics, entries, dates and wikilinks; the DB is only an index, always rebuildable from the files via full rescan
			- REST API: exposes topics, entries, daily view, wikilinks, health and admin operations
			- web frontend: SPA with topic view, daily view and admin view
	- Task
		- the app runs in the web browser as a SPA
		- single-user authentication: one password (`APP_PASSWORD` env var), login page, httpOnly session cookie — no user management, no registration
		- no nginx: the app is exposed directly on port `7777` in plain http; access is assumed via LAN or Tailscale (which already encrypts at the WireGuard level); optional TLS with a self-signed cert can be enabled natively via `Bun.serve` with `TLS_ENABLED=true`
		- pgadmin on port `7778`, but only when explicitly started with the `debug` compose profile — it is not running in normal operation
		- markdown files live in a bind-mounted directory so they survive container rebuilds and remain portable plain text
		- topic file naming convention (URI-like slug):
			- always lowercase
			- no spaces: the word separator is the dash `-`
			- no symbols: only `a-z`, `0-9` and `-` are allowed
			- the slug is derived from the topic title (lowercased, accents stripped, spaces and symbols collapsed to dashes, consecutive dashes collapsed to one, no leading/trailing dash)
			- examples: `Bitcoin Node` → `bitcoin-node.md`, `AEM 6.5 LTS!` → `aem-6-5-lts.md`
		- md file format per topic:
			- filename: `<topic-slug>.md`
			- first line: `# <Topic Title>` (original title with casing preserved)
			- entries grouped under date headings: `## YYYY-MM-DD`, in descending order (newest date first)
			- inside a date, each entry starts with a timestamp heading: `### HH:MM`, in descending order (newest time first)
			- entry content: free markdown text below the timestamp heading
			- wikilinks to other topics written as `[[Topic Title]]`
			- tolerance rules for external edits:
				- content directly under a `## YYYY-MM-DD` heading without a `### HH:MM` heading is indexed as a single timestamp-less entry for that date; entries created via the app always get a timestamp; timestamp-less entries stay timestamp-less after app edits
				- placement rule: timestamp-less content stays anchored immediately under its date heading; new `### HH:MM` blocks are always inserted *after* it (even though they sort newest-first among themselves) — otherwise inserting a newest timestamp above would demote the timestamp-less block and silently merge it into the new entry on the next parse
				- content between `# Title` and the first date heading is a topic description: preserved verbatim, indexed in `topics.description`, rendered in the topic view header, never touched by entry writes; editable only externally + reindex — no API endpoint touches it, by design
				- wikilinks in descriptions are rendered as clickable links but not indexed in the `wikilinks` table (which is entry-precise, `entry_id` not null) — they produce no backlinks, declared
				- duplicate `## YYYY-MM-DD` headings in one file (easy to create in vim): logically merged in the index under the same date; the file itself is left untouched; new entries (`POST`) for that date are still allowed and target the first occurrence (adding a block breaks no invariant), but existing entries under duplicated headings are read-only via the app — `PUT`/`DELETE` returns `409 "duplicate headings, normalize externally first"` (same UX as the stale-index check), because writing merged content to the first occurrence while the second stays in the file would duplicate content on the next reindex, violating the round-trip invariant
				- duplicate `### HH:MM` under the same date: same rules — logically merged in the index, file untouched, read-only until normalized externally
				- a non-date `## Section` heading makes the whole file invalid (e.g. `## Ideas` → `is_valid = false`, listed in the admin view) — dates are the only allowed H2 level
	- Specifications
		- tech stack
			- Runtime: `bun.sh`
			- API Framework: `Hono`
			- Frontend: `React + TypeScript + Vite`
			- Database: `PostgreSQL` (index only, never source of truth) with built-in extensions `unaccent` + `pg_trgm` for search — no external search engine (Meilisearch explicitly out of scope for a single-user tool)
			- Markdown structural parsing: custom parser written in TypeScript running on Bun, no external dependency — the format is fixed (H1 title, H2 dates, H3 timestamps, `[[wikilinks]]`) so a dedicated parser is simpler and stricter than a generic library; the parser MUST be fence-aware: heading and wikilink detection is disabled inside fenced code blocks (``` … ```), otherwise code snippets in developer notes would misparse the file structure or index phantom wikilinks — this is the most likely real-world corruption source
			- Markdown rendering (entry body → HTML in the frontend): pinned open-source renderer + sanitizer, e.g. `marked` + `DOMPurify`
			- Tests: `Bun test runner (built-in) + Supertest + Playwright for E2E`
		- data model (PostgreSQL index, always rebuildable from the md files)
			- `topics`
				- `id` serial primary key
				- `slug` text, unique, not null
				- `title` text, not null
				- `description` text, nullable — free content between `# Title` and the first date heading (see tolerance rules)
				- `file_path` text, not null
				- `file_mtime` timestamptz, not null — cheap fast-path pre-check for staleness
				- `file_hash` text, not null — SHA-256 of the file content at index time, the exact staleness signal for the `409` check (the indexer reads every file anyway, so the hash is free)
				- `is_valid` boolean, not null, default true
				- `validation_error` text, nullable — set when the file is malformed
				- `indexed_at` timestamptz, not null
			- `entries`
				- `id` serial primary key — internal only, never exposed by the API (a full rescan rebuilds the table and would invalidate it; the API uses the natural key instead)
				- `topic_id` integer, foreign key → `topics.id`, on delete cascade
				- `entry_date` date, not null
				- `entry_time` time, nullable — null only for timestamp-less external entries
				- `content` text, not null
				- `content_tsv` tsvector, generated always as `to_tsvector('simple', unaccent(content))` stored — self-maintaining, rebuilt for free by the full rescan; `simple` config (no per-language stemming) because entries mix Italian, Spanish and English
				- unique constraint on (`topic_id`, `entry_date`, `entry_time`) declared `NULLS NOT DISTINCT` (PG15+) — enforces both the same-minute append rule and the "one timestamp-less entry per date" tolerance rule (plain unique would treat NULL times as distinct)
				- GIN index on `content_tsv` for full-text search
			- search indexes on `topics`
				- GIN trigram index (`pg_trgm`) on `unaccent(title)` — fuzzy/typo-tolerant and accent-insensitive matching (`bitcon` → `Bitcoin Node`, `perche` → `Perché`), also powering the topic autocomplete; note: `unaccent()` is only STABLE, so the expression index needs an IMMUTABLE wrapper function (known Postgres gotcha)
			- `wikilinks`
				- `id` serial primary key
				- `entry_id` integer, foreign key → `entries.id`, not null, on delete cascade — links belong to the entry where they appear, so entry cards can show their own chips and backlinks can point to the exact entry; wikilinks in topic descriptions are therefore rendered but never indexed (declared in the tolerance rules)
				- `source_topic_id` integer, foreign key → `topics.id`, on delete cascade — denormalized for fast topic-level backlink queries
				- `target_slug` text, not null — the target topic may not exist yet ("missing" link)
				- unique constraint on (`entry_id`, `target_slug`)
		- API endpoints
			- `POST /api/auth/login` → `{ password }`; on success sets the session cookie; rejects with a constant-time comparison against `APP_PASSWORD`
			- `POST /api/auth/logout` → invalidates the session cookie
			- all endpoints below require a valid session, except `GET /health`
			- `GET /health` → status of app and DB connection, used as Docker healthcheck; unauthenticated, returns no sensitive data
			- `GET /docs` → Swagger UI over the OpenAPI spec
			- `GET /api/topics` → list of topics with slug, title, entry count, last entry date, validity flag
			- `GET /api/topics/:slug` → full topic: description, entries in descending order (timestamp-less entries last within their date — declared explicitly, since Postgres `DESC` would put NULLs first by default; the query uses `NULLS LAST`), and backlinks (entry-precise, from the `wikilinks` table)
			- `POST /api/entries` → create an entry: `{ topicTitle, date, content }`; creates the topic file if it does not exist; timestamp is assigned server-side
			- entries are addressed by their natural key `(slug, date, time)` — stable across reindexes, unlike the internal serial id; `:time` is `HH:MM`, or the literal `-` for timestamp-less entries
			- `PUT /api/topics/:slug/entries/:date/:time` → edit the content of a single entry; returns `409` if the file changed on disk since last index (stale-index check) or if the entry sits under duplicated headings (normalize externally first)
			- `DELETE /api/topics/:slug/entries/:date/:time` → delete a single entry; removes empty timestamp/date headings from the md file; same two `409` checks (stale index, duplicated headings)
			- `GET /api/days/:date` → all entries of that date across topics, each with its topic slug and title; newest first, timestamp-less entries last (`NULLS LAST`)
			- `GET /api/search?q=` → single combined query: fuzzy topic-title matches (trigram) + full-text content matches (`websearch_to_tsquery`, so Google-like syntax: `"exact phrase"`, `-exclude`, `OR`), ranked with `ts_rank`, each result with topic, date and a `ts_headline` snippet with highlighted terms; `ts_headline` runs over a dedicated `daybook_simple` text search configuration (`simple` + `unaccent` as a filtering dictionary) so an accent-less query still highlights the accented original while the snippet keeps its real spelling — the generated `content_tsv` column cannot use it (regconfig lookups are not IMMUTABLE) and keeps `to_tsvector('simple', immutable_unaccent(...))`, which yields identical lexemes
			- `GET /api/autocomplete/topics?q=` → trigram-based topic title suggestions for the entry editor; deliberately outside the `/api/topics/:slug` namespace — `autocomplete` is itself a valid slug, so nesting it there would make a topic titled "Autocomplete" unreachable
			- `POST /api/admin/reindex` → full rescan of the topics directory, rebuilds the whole index
				- `GET /api/admin/status` → backing data for the admin view: last reindex stats (in-memory, process lifetime), indexed topic/entry counts, list of invalid files with their errors
		- ui/ux (inspired by Karakeep's dashboard)
			- layout
				- left sidebar: Daily (home), Topics, Admin; app name on top, version at the bottom
				- top bar: prominent global search field (submits to the search view), date navigation when in daily view
				- responsive: sidebar collapses on mobile, card grid becomes single column
			- daily view
				- masonry card grid
				- a permanent "new entry" quick-capture card at the top of the grid: topic autocomplete + side-by-side markdown editor, save without leaving the view
				- each entry is a card: topic title as clickable label (→ topic view), `HH:MM` timestamp, rendered markdown content, wikilinks as chips at the bottom
			- topic view
				- same card language: entries as cards grouped under date headers, descending
				- topic title as page header, entry/date count, wikilink backlinks ("mentioned in") as chips
			- search view
				- results as cards: topic label, date, `ts_headline` snippet with highlighted matching terms
				- topic-title matches shown first, content matches ranked below
			- theming
				- dark mode from v1: light/dark toggle in the sidebar, defaulting to the system preference (`prefers-color-scheme`), choice persisted
		- use cases
			- login
				- user opens any page while unauthenticated and is redirected to the login page
				- user enters the single app password; on success a httpOnly, `SameSite=Strict` session cookie is set and the user lands on the daily view
				- session expires after `SESSION_TTL_HOURS`; logout button available in the UI
			- write an entry for today
				- user opens the daily view at `http://localhost:7777/`, today is preselected
				- user types the topic name in an autocomplete field (existing topics suggested, new title allowed)
				- user writes markdown content in the entry editor (side-by-side live preview: markdown on the left, rendered output on the right) and saves
				- the app derives the slug, creates `<topic-slug>.md` with the `# Title` line if missing, and inserts the content under `## YYYY-MM-DD` / `### HH:MM` at the correct descending position
				- the index is updated in the same operation
			- write an entry for a different date (past or future)
				- user navigates the daily view to any date via date picker or prev/next arrows; future dates are allowed without limit
				- user writes content for a topic exactly as in the "today" case; the entry lands under that date heading, with the current wall-clock timestamp
			- read a topic
				- user opens `http://localhost:7777/topic/<slug>` and sees the whole file rendered, dates and entries in descending order
				- wikilinks are clickable and navigate to the linked topic; links to non-existent topics render in "missing" style and open the new-entry flow
			- read a day
				- user opens the daily view for a date and sees all entries of that date across topics, newest first, each block labelled with its topic and linking to the topic view
			- edit an existing entry
				- from topic view or daily view, user edits the markdown of a single entry in the same side-by-side live preview editor and saves
				- the md file is rewritten atomically preserving everything else; the index is updated
				- the UI distinguishes the two `409` cases: stale-index → explains it and offers a one-click "reindex and retry" (which works); duplicate headings → explains that retry won't help and the file must be normalized externally (vim) before editing via the app
				- timestamp-less external entries stay timestamp-less after an app edit — the app never rewrites structure it did not create
			- external edit of a md file
				- user edits `<topic-slug>.md` directly with vim on the server
				- no file watcher: the user opens `http://localhost:7777/admin` and clicks the reindex button, which triggers `POST /api/admin/reindex` (full rescan)
				- if a file is malformed (missing `# Title`, broken date heading, invalid date) the indexer marks the topic `is_valid = false` with a `validation_error` and the admin view lists the invalid files instead of crashing or silently skipping them
			- rename a topic
				- rename is done externally: the user renames the file (and optionally the `# Title` line) on disk, then manually clicks the reindex button in `/admin`
				- backlink rewriting is out of scope: after a rename, old `[[Old Title]]` links simply become "missing" links
			- admin view
				- `http://localhost:7777/admin` shows: reindex button, last reindex timestamp and duration, number of topics/entries indexed, list of invalid files with their validation errors
			- search
				- user types in the top-bar search field from any view and submits
				- the search view shows fuzzy topic-title matches first, then full-text content matches with highlighted snippets; clicking a result opens the topic view scrolled to that entry
				- Google-like query syntax supported: `"exact phrase"`, `-exclude`, `OR`
			- edge cases
				- topic titles differing only by casing, accents or symbols resolve to the same slug and therefore the same file, no duplicates; the `# Title` line of the existing file wins
				- two app-created entries on the same topic within the same minute: content is appended inside the existing `### HH:MM` block
				- deleting the last entry of a timestamp removes the `### HH:MM` heading; deleting the last entry of a date removes the `## YYYY-MM-DD` heading; the topic file is never deleted by the app — with zero entries it keeps only its `# Title` line (file deletion happens only externally + reindex)
				- a slug that would become empty after normalization (e.g. title made only of symbols) is rejected with a clear validation error
	- Quality Criterias
		- all technologies open source
		- all Docker images pinned, no `:latest`
		- md files are always the source of truth: dropping the DB and running a full reindex must reproduce the exact same state
		- writes to md files must be atomic (write temp file + rename) to avoid corruption
		- topic files are read with `node:fs/promises.readFile`, never `Bun.file()`: a `BunFile` caches the size from an earlier `stat`/`exists()` and a later `.text()` returns only that many bytes, so a file grown by an external editor reads back as its pre-edit content — the stale-index check would then compare stale content against the hash of that same stale content, pass, and destroy the external edit it exists to protect; file existence is derived from `ENOENT` on the read itself (a separate `exists()` is both the cache trigger and a TOCTOU gap)
		- stale-index check: every app write to a topic file first compares the file's current SHA-256 content hash with `topics.file_hash` (mtime alone is a weak signal — 1-second granularity on some filesystems); if they differ (external edit since last index) the write is refused with `409 "file changed on disk, reindex first"` — an app edit after an un-reindexed vim edit must never silently mangle the file; `file_mtime` is kept only as a cheap fast-path pre-check before hashing
		- write serialization: all file writes go through a single in-process write queue (global — single-user tool), so two browser tabs saving concurrently cannot lose updates; atomicity prevents corruption, the queue prevents lost read-modify-writes
		- sessions are stateless signed cookies (`SESSION_SECRET`): they survive container restarts and logout only clears the browser cookie without server-side invalidation — accepted consequence of this threat model, exposure bounded by `SESSION_TTL_HOURS`
		- schema migrations: none — the DB is disposable by design, so any schema change is "drop the DB, recreate from `schema.sql`, reindex"; no migration tooling ever
		- pagination: none in v1 — declared acceptable for years of single-user notes; revisit only if a daily or topic view exceeds a few hundred entries
		- SPA fallback routing: unknown non-`/api` paths serve `index.html`, so deep links like `/topic/<slug>` survive a refresh
		- backup story: backing up `TOPICS_DIR` is the whole backup — the DB needs none, it is always rebuildable
		- full rescan must be idempotent and safe to trigger at any moment, including while the UI is open; to guarantee it, reindex enqueues on the same write queue as any file write — it never reads files while a mutation is in flight, so it can never index a half-consistent view
		- search scope, declared: FTS covers `entries.content`, trigram covers topic titles; `topics.description` is visible in the topic view but invisible to search — accepted for v1, revisit only if it ever hurts
		- test pyramid: unit (`bun test tests/unit`, no infrastructure) → integration (`bun run test:integration`, against a separate ephemeral Postgres from `docker-compose.test.yml`: own stack/container/network names, tmpfs storage, host port bound to 127.0.0.1 — never the dev/prod database, which intentionally exposes no host port) → regression (fixtures reproducing past bugs, starting with the malformed files in `test-fixtures/topics/` — every bug fixed later adds its reproducing fixture here) → E2E (`bun run test:e2e`, Playwright against the running production compose stack)
		- the layers are not interchangeable: integration tests use native-filesystem temp directories and mutate files from the *same* process, so they structurally cannot catch container-runtime or bind-mount defects. E2E is the only layer that exercises the real container, the real bind mount, and edits made by a *different* process — the file-reading defect above was found there and passed the integration tests unchanged.
		- config via env vars only; `.env.example` committed, `.env` gitignored; validated at startup with Zod
		- environment variables:
			- `APP_PORT` (default `7777`)
			- `APP_PASSWORD` (no default, required — startup fails if missing or empty)
			- `SESSION_SECRET` (no default, required — used to sign session cookies)
			- `SESSION_TTL_HOURS` (default `168`)
			- `TLS_ENABLED` (default `false`)
			- `TLS_CERT_PATH` / `TLS_KEY_PATH` (required only if `TLS_ENABLED=true`)
			- `TOPICS_DIR` (default `/data/topics`)
			- `POSTGRES_HOST` (default `postgres`)
			- `POSTGRES_PORT` (default `5432`)
			- `POSTGRES_DB` (default `daybook`)
			- `POSTGRES_USER` (default `postgres`)
			- `POSTGRES_PASSWORD` (no default, required)
			- `POSTGRES_DATA_DIR` (required, absolute path — e.g. `/Users/<user>/opt/docker/postgres/app-daybook`; no `~`, unreliable in compose substitution) — host path for the postgres data volume
			- `PGADMIN_DEFAULT_EMAIL` / `PGADMIN_DEFAULT_PASSWORD` (no default, required only for the `debug` profile)
			- `TZ` (default `Europe/Madrid`) — used for "today" and server-side timestamps
		- security
			- authentication
				- single-user password from `APP_PASSWORD`, compared with a constant-time comparison
				- session in a signed, httpOnly, `SameSite=Strict` cookie; `Secure` flag set automatically when `TLS_ENABLED=true`
				- every API route except `/health` and `/api/auth/login` rejects unauthenticated requests with 401
			- transport
				- plain http by default, intended for LAN/Tailscale access only
				- optional native TLS via `Bun.serve` with a self-signed cert when `TLS_ENABLED=true`
				- the app binds on `0.0.0.0` inside the container; exposure outside the host is the user's network responsibility (Tailscale recommended)
			- network surface
				- postgres exposes no host port: reachable only inside `daybook-network`
				- pgadmin runs only under the `debug` compose profile (`docker compose --profile debug up`), reaches postgres via the internal network, credentials from env
			- container hardening
				- app runs as a non-root user in the Dockerfile
				- app container filesystem read-only except `TOPICS_DIR` and a tmpfs for temp files
				- `no-new-privileges: true` on all services
			- application
				- rendered markdown sanitized with DOMPurify against XSS
				- slugs validated server-side as `^[a-z0-9]+(-[a-z0-9]+)*$` so no path traversal outside `TOPICS_DIR` is possible
				- CORS restricted to same-origin
				- `.env.example` contains only placeholder values (e.g. `changeme`), never real-looking defaults; `.env` gitignored
			- explicitly out of scope (single-user personal tool): rate limiting, audit log, multi-user roles
		- OpenAPI spec + Swagger UI (`@hono/swagger-ui`) served at `/docs`, behind the session
		- Bruno collection committed in the repo (`bruno/` folder, `.bru` files): one request per API endpoint, a local environment (`http://localhost:7777`, password via Bruno env var, session cookie handled after login request), kept in sync with the API — any endpoint change updates both the OpenAPI spec and the Bruno collection
		- curl documentation: `README.md` has an "API usage" section with a copy-pasteable curl example for every endpoint; since auth is session-cookie based (no API key), the section starts with the cookie-jar flow — `curl -c cookies.txt` on login, then `-b cookies.txt` on every authenticated call; examples use placeholder values only, never real passwords; kept in sync with the API together with OpenAPI and Bruno
		- healthcheck endpoints: `GET /health` for the app (used by Docker healthcheck), `pg_isready` for postgres
	- Response Format
		- docker-compose with:
			- `app` service (bun): API + built frontend, ports `${APP_PORT:-7777}:${APP_PORT:-7777}` (parametric, otherwise the env var would be dead), volume `./data/topics:/data/topics:rw`, non-root user, `read_only: true` + tmpfs, `no-new-privileges`, healthcheck on `/health`, depends on postgres healthy
			- `postgres` service: image `postgres:18.4-alpine3.24`, container_name `daybook-postgres`, restart `unless-stopped`, no host port exposed, `PGDATA: /var/lib/postgresql/data` pinned explicitly (postgres 18+ images moved the default to a version-specific subdirectory, which turns the volume below into an "unused mount" and aborts startup), volume `${POSTGRES_DATA_DIR}:/var/lib/postgresql/data:rw` — `POSTGRES_DATA_DIR` must be an absolute path in `.env` (e.g. `/Users/<user>/opt/docker/postgres/app-daybook`): `~` is not reliably tilde-expanded by all compose versions after variable substitution — env vars via `${VAR}` (password required, no default), `no-new-privileges`, healthcheck `pg_isready`
			- `pgadmin` service: image `dpage/pgadmin4:9.16`, `profiles: ["debug"]`, ports `7778:8080` (NOT `7778:80` — under `no-new-privileges` the image detects a restricted security context and listens on 8080 instead of root's port 80; it also hard-exits on empty credentials, so default them to empty strings in compose), restart `unless-stopped`, credentials from env, `no-new-privileges`
			- named bridge network `daybook-network` shared by all services
		- code generation is now allowed, strictly phase by phase: implement one phase, run its tests, present the results, and WAIT for explicit confirmation before starting the next phase — never generate code for a future phase in advance
		- decided (was open):
			- entry editor: side-by-side live preview (markdown left, rendered output right), same component for create and edit
			- the topic file is never deleted by the app, even with zero entries — deletion happens only externally + reindex
			- timestamp-less external entries stay timestamp-less after app edits
			- Swagger UI via `@hono/swagger-ui`, `/docs` behind the session like every other route (only `/health` and login are open)
			- search in v1 scope, implemented entirely in Postgres (FTS `simple`+`unaccent` for content, `pg_trgm` for topic titles); Meilisearch explicitly out of scope
			- UI inspired by Karakeep: sidebar + top search bar + masonry card grid; quick-capture card in the daily view
			- topic view uses the same card language, entries as cards grouped by date
			- dark mode from v1 (toggle + system preference, persisted)
			- from the spec review, second pass (items 5–12): description invisible to search (declared, revisit if it hurts); `GET /api/topics/:slug` returns description + entry-precise backlinks; staleness signal upgraded from mtime to SHA-256 `file_hash` (mtime kept as fast-path); reindex enqueues on the write queue (never overlaps a mutation); timestamp-less entries sort last within their date (`NULLS LAST`, declared since Postgres `DESC` defaults to NULLs first); compose port mapping parametric on `APP_PORT`; `POSTGRES_DATA_DIR` required as absolute path (no `~` in compose substitution); regression tests defined (fixtures reproducing past bugs, seeded by `test-fixtures/topics/`); description editable only externally + reindex, by design
			- from the external spec review: wikilinks stored per-entry (`entry_id` FK) so chips and backlinks are entry-precise; parser is fence-aware; entries addressed by natural key `(slug, date, time)` instead of serial ids; stale-index `409` check on writes; global in-process write queue; stateless signed-cookie sessions (logout is client-side only, accepted); `NULLS NOT DISTINCT` on the entry uniqueness constraint; trigram index on `unaccent(title)` via IMMUTABLE wrapper; no schema migrations (drop+reindex); no pagination in v1; SPA fallback routing; backup = `TOPICS_DIR` only
			- from the spec review, final pass (items 1–4, the parser/writer contracts): autocomplete moved out of the `:slug` namespace (`GET /api/autocomplete/topics?q=` — "autocomplete" is a valid slug); placement rule — timestamp-less content stays anchored under its date heading, new `### HH:MM` blocks inserted after it; entries under duplicated headings are read-only (`409 "duplicate headings, normalize externally first"`, POST still allowed targeting the first occurrence) to protect the round-trip invariant; wikilinks in descriptions rendered but not indexed (`entry_id` stays not null)
		- no open questions left — the spec is closed; implementation follows the Development Phases below
	- Development Phases
		- Phase 1 — Scaffolding & infrastructure
			- [x] repo structure as in Proposed Project Structure; bun project init, TypeScript config, Vite config
			- [x] `docker-compose.yml` (app, postgres, pgadmin under `debug` profile), `Dockerfile` (multi-stage, non-root, read-only), `.env.example`, `.gitignore`
			- [x] `schema.sql` complete: tables, `NULLS NOT DISTINCT` constraint, extensions (`unaccent`, `pg_trgm`), IMMUTABLE unaccent wrapper, GIN indexes
			- [x] env validation with Zod at startup; `GET /health`
			- success criteria: `docker compose up` brings app + postgres to healthy; `/health` returns app+DB status; `bun test` runner wired and green (even with zero tests)
		- Phase 2 — Core pure functions (no infrastructure)
			- [x] `slugify.ts` with the full normalization rules
			- [x] `parser.ts`: fence-aware, all tolerance rules (description, timestamp-less, duplicate headings, non-date H2 → invalid), wikilink extraction per entry
			- [x] `writer.ts`: atomic write, descending placement, timestamp-less anchoring rule, empty-heading cleanup
			- [x] unit tests for all three + `test-fixtures/topics/` seeded with valid and malformed files
			- success criteria: all unit tests green; round-trip property holds — parse → write → parse yields identical structure on every fixture
		- Phase 3 — Indexer + DB
			- [x] `indexer.ts`: full rescan, `file_hash`/`file_mtime`, topics/entries/wikilinks/description population, invalid-file flagging
			- [x] integration tests: API-less, real Postgres + real files in a temp dir
			- success criteria: drop DB + reindex reproduces the exact same index state; malformed fixtures are flagged, never crash the scan
		- Phase 4 — API
			- [x] auth (login/logout, signed cookie, constant-time compare, session middleware), write queue (reindex included)
			- [x] all routes with both `409` checks; OpenAPI spec + Swagger UI at `/docs` behind the session
			- [x] Bruno collection (all folders incl. `search/`) + README "API usage" curl section (cookie-jar flow)
			- [x] integration tests over the API (via Hono's `app.request()`, which runs the whole middleware pipeline without a listening server — Supertest wraps Node http servers and is redundant here; real HTTP is covered by the Bruno run and the E2E suite)
			- success criteria: the whole Bruno collection runs green top to bottom against a fresh `docker compose up`; unauthenticated requests get 401 everywhere except `/health` and login
		- Phase 5 — Frontend
			- [x] layout (sidebar, top bar), TopicsView (the sidebar's Topics destination), DailyView with masonry grid + quick-capture card, TopicView (cards by date, description header, backlinks), AdminView, LoginView
			- [x] EntryEditor side-by-side live preview; EntryCard with DOMPurify; both `409` UI flows; dark mode (toggle + system preference, persisted); SPA fallback routing
			- success criteria: every use case in the spec is walkable by hand in the browser; lighthouse-level sanity on mobile layout
		- Phase 6 — Search UI
			- [x] SearchView + top-bar SearchBar wiring; autocomplete in the entry editor; result → exact-entry deep link
			- note: the `search.ts` route and `GET /api/autocomplete/topics` are delivered in Phase 4, not here — Phase 4's success criterion ("the whole Bruno collection runs green") covers every endpoint, so the API cannot be split across phases. Phase 6 is UI only.
			- success criteria: multilingual queries (it/es/en) return accent-insensitive results with highlighted snippets; typo'd topic titles still match
		- Phase 7 — E2E & hardening
			- [x] Playwright E2E covering: login, create entry (today + other date), edit with both 409 paths, external edit + reindex, search, dark mode persistence
			- [x] container hardening verified (as assertions in the E2E suite, not one-off checks) (non-root, read-only fs, no-new-privileges), backup doc note in README
			- success criteria: full E2E suite green against the production compose stack; `docker compose --profile debug up` brings pgadmin up connected
	- As-Built Notes (v2.1 — recorded after implementation; the spec above is already corrected)
		- corrected in this revision, because reality contradicted v2: pgadmin maps `7778:8080` (not `:80`) under `no-new-privileges`; postgres 18+ needs `PGDATA` pinned to keep the documented volume path valid; the search/autocomplete API routes belong to Phase 4 (Phase 6 is UI only), because Phase 4's own success criterion covers every endpoint; `GET /api/admin/status` was added because the spec'd admin view content had no queryable source; `ts_headline` needs its own `daybook_simple` configuration for accent-insensitive highlighting; topic files must be read with `readFile`, never `Bun.file()`
		- structural additions the spec's tree did not anticipate: `src/server/env.ts` (Zod-validated config as its own module — `db/client.ts` needs it too, and importing it from `index.ts` would be circular); `src/server/app.ts` (a `createApp(deps)` factory, so integration tests build the whole API against a test database and a temp directory with no env singletons); `db/appDb.ts` (the single env-wired client) beside the pure `db/client.ts` factory; `core/writeQueue.ts`; `src/frontend/views/TopicsView.tsx`
		- environment caveat, not an application defect: on macOS Docker Desktop, VirtioFS caches file attributes for roughly a second, so a read issued inside the container immediately after a *host-side* write can still return pre-write content and the stale-index `409` does not fire. Linux bind mounts share the host page cache and are coherent immediately, so this affects local development only — the E2E helper waits ~1.5s after an external edit for exactly this reason, and that wait must not be removed as a "sleep in tests" smell
		- deliberately not built (out of scope, unchanged): rate limiting, audit log, multi-user roles, backlink rewriting on rename, file watcher, pagination, schema migrations
	- Verification
		- every time review your output in order to avoid errors, duplications, inconsistencies and unused parts
		- once we will have the tests, run them all, so when i will run them in my ide I will not have issues
	- Proposed Project Structure
		- ```
		  app-daybook/
		  ├── README.md                       # setup + "API usage" section with curl examples (cookie-jar login flow)
		  ├── docker-compose.yml
		  ├── docker-compose.test.yml         # ephemeral Postgres for integration tests (tmpfs)
		  ├── Dockerfile                      # multi-stage: build frontend, run bun server
		  ├── playwright.config.ts
		  ├── .env.example
		  ├── .env.test.example
		  ├── .gitignore                      # .env, .env.test, data/, test-results/
		  ├── data/
		  │   └── topics/                     # bind mount, the md files (source of truth)
		  ├── bruno/                          # Bruno API collection (.bru), synced with the API
		  │   ├── bruno.json
		  │   ├── environments/
		  │   │   └── local.bru               # base url http://localhost:7777, APP_PASSWORD var
		  │   ├── auth/                       # login, logout
		  │   ├── topics/
		  │   ├── entries/
		  │   ├── days/
		  │   ├── search/                     # search, autocomplete
		  │   └── admin/                      # reindex, health
		  ├── src/
		  │   ├── server/
		  │   │   ├── index.ts                # bootstrap: schema apply + createApp + Bun.serve
		  │   │   ├── app.ts                  # createApp(deps): routes, guards, DI seam
		  │   │   ├── env.ts                  # Zod-validated config (own module: db/ needs it too)
		  │   │   ├── routes/
		  │   │   │   ├── auth.ts             # login/logout, signed-cookie session middleware
		  │   │   │   ├── docs.ts             # OpenAPI spec + Swagger UI (behind the session)
		  │   │   │   ├── topics.ts
		  │   │   │   ├── entries.ts
		  │   │   │   ├── days.ts
		  │   │   │   ├── search.ts           # FTS + trigram combined query, autocomplete
		  │   │   │   ├── admin.ts            # reindex endpoint
		  │   │   │   └── health.ts
		  │   │   ├── core/
		  │   │   │   ├── slugify.ts          # title → slug rules
		  │   │   │   ├── parser.ts           # md structural parser (H1/H2/H3/wikilinks)
		  │   │   │   ├── writer.ts           # atomic md file writer, heading placement
		  │   │   │   ├── writeQueue.ts       # global mutation serializer (reindex included)
		  │   │   │   └── indexer.ts          # full rescan + single-topic reindex → Postgres
		  │   │   └── db/
		  │   │       ├── schema.sql          # tables, extensions, IMMUTABLE unaccent, GIN, daybook_simple
		  │   │       ├── client.ts           # pure factory: createDbClient(config), applySchema(sql)
		  │   │       └── appDb.ts            # the single env-wired client instance
		  │   └── frontend/
		  │       ├── main.tsx
		  │       ├── api.ts                  # typed client + 409 classification
		  │       ├── markdown.ts             # marked + DOMPurify + wikilink resolution
		  │       ├── theme.ts                # dark mode (system default, persisted)
		  │       ├── views/
		  │       │   ├── LoginView.tsx
		  │       │   ├── DailyView.tsx       # masonry grid + quick-capture card
		  │       │   ├── TopicsView.tsx      # topic index (sidebar "Topics" destination)
		  │       │   ├── TopicView.tsx       # cards by date, description, backlinks
		  │       │   ├── SearchView.tsx      # results with highlighted snippets
		  │       │   └── AdminView.tsx
		  │       └── components/
		  │           ├── Sidebar.tsx         # nav + theme toggle
		  │           ├── SearchBar.tsx       # top-bar global search
		  │           ├── EntryEditor.tsx     # autocomplete topic + side-by-side md editor
		  │           ├── EntryCard.tsx       # rendered entry card (marked + DOMPurify)
		  │           └── DatePicker.tsx
		  ├── tests/
		  │   ├── unit/                       # slugify, parser, writer, round-trip property
		  │   ├── integration/                # indexer + API, real Postgres, temp topics dir
		  │   └── e2e/                        # Playwright vs. running stack + hardening
		  ├── .github/workflows/ci.yml        # unit + integration on push/PR
		  └── test-fixtures/
		      └── topics/                     # sample md files, incl. malformed ones
		  ```
