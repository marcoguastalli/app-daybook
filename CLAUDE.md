# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current State

The authoritative spec is **`app-daybook v2.1.md`** — the as-built revision: every phase checked off, the places where reality contradicted the pre-implementation spec corrected in place, and an "As-Built Notes" section recording what changed and why. Earlier revisions (v1.5–v2) are not kept in the repo.

**Progress: all 7 phases done** — the spec is fully implemented. Tests: 42 unit, 38 integration, 19 E2E.

**Known deviation from the spec's phase split (agreed with the user):** the search + autocomplete API routes were implemented in Phase 4 (so "all routes" and the full Bruno collection hold), leaving Phase 6 as search *UI* only. Bruno note: the CLI runs root-level requests after folders, so `bruno/_bootstrap/` (seq 1) logs in first and `auth/` runs last (logout ends the run); collection-level pre-request scripts don't compile in the CLI sandbox (no top-level await/require) — don't reintroduce them.

All 7 phases are complete, so the phase gate no longer applies to new work; if the spec is ever extended with further phases, the same rule holds — implement exactly one phase, run its tests, present the results, and wait for explicit confirmation before the next.

CI (`.github/workflows/ci.yml`) runs type-check + build + unit + integration on push/PR, plus a separate E2E job that builds the compose stack.

## What app-daybook Is

A self-hosted, single-user, topic-centric note-taking app (Logseq inverted): **one `.md` file per topic** with dated entries inside it, instead of one file per day. The daily view ("what did I write on date X across all topics?") is an index query, never duplicated content.

Four parts:
1. **Markdown file storage** — one file per topic in a bind-mounted `TOPICS_DIR`, editable externally (vim, VS Code)
2. **Indexer** — parses md files into a PostgreSQL index (topics, entries, dates, wikilinks)
3. **REST API** — Hono on Bun, session-cookie auth, port 7777
4. **Web frontend** — React + TypeScript + Vite SPA (daily / topic / search / admin views)

## Non-Negotiable Invariants

- **Md files are the single source of truth.** The Postgres DB is only an index: dropping it and running a full reindex (`POST /api/admin/reindex`) must reproduce the exact same state.
- **Atomic file writes**: write temp file + rename, never in-place.
- **The app never deletes a topic file** — even with zero entries it keeps its `# Title` line. Deletion and renames happen only externally, followed by manual reindex (no file watcher).
- **The app never rewrites structure it did not create**: timestamp-less external entries (content directly under a `## YYYY-MM-DD` heading) stay timestamp-less after app edits.
- Full rescan must be idempotent and safe at any moment; malformed files get `is_valid = false` + `validation_error` instead of crashing or being silently skipped.

## File Format (fixed — custom parser, no markdown library)

- Filename: `<topic-slug>.md`; slug rule `^[a-z0-9]+(-[a-z0-9]+)*$` (lowercase, accents stripped, symbols/spaces → dashes, collapsed). Slug validation server-side also prevents path traversal.
- Line 1: `# <Topic Title>` (original casing). Titles differing only by case/accents/symbols resolve to the same slug/file; the existing file's `# Title` wins.
- `## YYYY-MM-DD` date headings, descending; `### HH:MM` timestamp headings inside, descending; free markdown below; `[[Topic Title]]` wikilinks (targets may not exist yet — "missing" links).
- Two app entries in the same minute on the same topic are appended into the same `### HH:MM` block (unique constraint on `topic_id, entry_date, entry_time`).

## Tech Stack (decided)

- Runtime **Bun**, API **Hono**, frontend **React + TypeScript + Vite**
- **PostgreSQL** with `unaccent` + `pg_trgm` — search is entirely in Postgres (FTS with `simple` config because entries mix Italian/Spanish/English; trigram for fuzzy topic titles). Meilisearch explicitly out of scope.
- Markdown structural parsing: **custom TypeScript parser** (format is fixed, no external dependency). Rendering in frontend: `marked` + `DOMPurify`.
- Tests: **Bun test runner** + Supertest + Playwright (E2E). Pyramid: unit (slugify, parser, writer) → integration (API + Postgres + real files in temp dir) → E2E.
- Config via env vars only, validated at startup with Zod; `APP_PASSWORD`, `SESSION_SECRET`, `POSTGRES_PASSWORD` required with no defaults. Full list in the spec.
- Docker: all images pinned (no `:latest`), app non-root with read-only filesystem + tmpfs, postgres with no host port, pgadmin only under the `debug` compose profile (port 7778). Plain HTTP on 7777 (LAN/Tailscale assumed); optional native TLS via `Bun.serve`.

## API Documentation Sync Rule

Any endpoint change must update **three things together**: the OpenAPI spec (Swagger UI at `/docs` via `@hono/swagger-ui`, behind the session), the Bruno collection in `bruno/`, and the curl examples in README's "API usage" section (cookie-jar flow: `curl -c cookies.txt` on login, `-b cookies.txt` after).

## Commands

```bash
bun install                         # dependencies
bun test                            # unit tests only (tests/unit) — no infra needed
bun test tests/unit/<file>          # single unit test file
bun run test:integration            # integration tests — needs the ephemeral test Postgres, see below
bunx tsc --noEmit                   # strict type-check, whole project
docker compose up --build           # full stack (app + postgres)
docker compose --profile debug up   # additionally starts pgadmin on 7778 (host port 8080-mapped, see docker-compose.yml comment)
docker compose -f docker-compose.yml -f docker-compose.shared-db.yml up app --no-deps  # use the shared Postgres in my_docker/postgres/src/v1 instead (see README "Shared Postgres mode")
```

Integration tests run against a **separate, ephemeral** Postgres (`docker-compose.test.yml`, tmpfs storage, its own stack/container/network names) — never the dev/prod one, which intentionally has no host port:

```bash
cp .env.test.example .env.test      # once
docker compose -f docker-compose.test.yml up -d
bun run test:integration
docker compose -f docker-compose.test.yml down
```

`src/server/db/client.ts` is a pure factory (`createDbClient(config)`, `applySchema(sql)`) with no dependency on `env.ts` — this is what makes it usable both by the app's singleton (`db/appDb.ts`, env-wired) and by tests (constructed directly against the test DB). Core logic (`core/*.ts`) takes a `Sql` client as a parameter rather than importing a singleton, for the same reason.

The proposed project layout (`src/server/{routes,core,db}`, `src/frontend/{views,components}`, `tests/{unit,integration,e2e}`, `test-fixtures/topics/`) is at the end of the spec — follow it.

**Known deviation from the spec's compose snippet**: pgadmin must map `7778:8080`, not `7778:80` — under `no-new-privileges` the image detects a restricted security context and listens on 8080 instead of root's port 80.

## File-Reading Rules (learned the hard way)

**Never read topic files with `Bun.file()`.** A `BunFile` caches the size from an earlier `stat`/`exists()`, and a later `.text()` returns only that many bytes — so a file grown by an external editor reads back as its *pre-edit* content. In `loadForWrite` that made the stale-index check compare stale-vs-stale, pass, and silently destroy the external edit. Both read sites (`routes/entries.ts`, `core/indexer.ts`) use `node:fs/promises.readFile`, which reads to EOF. Don't "simplify" them back.

**macOS dev-only timing artifact**: Docker Desktop's VirtioFS caches file attributes for ~1s, so a container read issued immediately after a *host* write can still see pre-write content — the stale-index 409 then doesn't fire. This is not an app bug (Linux bind mounts share the host page cache and are coherent immediately), which is why `tests/e2e/helpers.ts` `externalEdit()` waits 1.5s after appending. Don't remove that wait on macOS.

## Testing Layers

`bun test tests/unit` (no infra) → `bun run test:integration` (ephemeral Postgres) → `bun run test:e2e` (Playwright vs. the running compose stack, includes container-hardening assertions). E2E is the only layer that can catch bind-mount/container-runtime issues — integration tests use native-fs temp dirs and same-process writes, which mask them.
