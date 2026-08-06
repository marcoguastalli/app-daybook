import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDbClient, type Sql } from "../../src/server/db/client";
import { reindexAll } from "../../src/server/core/indexer";

const FIXTURES = join(import.meta.dir, "../../test-fixtures/topics");

let sql: Sql;
let dir: string;

beforeAll(async () => {
  sql = createDbClient({
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? 55432),
    database: process.env.POSTGRES_DB ?? "daybook_test",
    username: process.env.POSTGRES_USER ?? "postgres",
    password: process.env.POSTGRES_PASSWORD ?? "test",
  });
  await applySchema(sql);
  dir = await mkdtemp(join(tmpdir(), "daybook-index-"));
  await cp(FIXTURES, dir, { recursive: true });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await sql.end();
});

async function topics() {
  return sql`
    SELECT slug, title, description, is_valid, validation_error
    FROM topics ORDER BY slug
  `;
}

async function entries() {
  return sql`
    SELECT t.slug, e.entry_date, e.entry_time, e.content
    FROM entries e JOIN topics t ON t.id = e.topic_id
    ORDER BY t.slug, e.entry_date, e.entry_time NULLS FIRST
  `;
}

async function wikilinks() {
  return sql`
    SELECT t.slug AS source_slug, w.target_slug
    FROM wikilinks w JOIN topics t ON t.id = w.source_topic_id
    ORDER BY t.slug, w.target_slug
  `;
}

describe("reindexAll", () => {
  it("indexes valid fixtures with correct slug/title/description", async () => {
    await reindexAll(sql, dir);
    const rows = await topics();

    const bitcoin = rows.find((r) => r.slug === "bitcoin-node");
    expect(bitcoin).toMatchObject({
      title: "Bitcoin Node",
      is_valid: true,
      validation_error: null,
    });
    expect(bitcoin!.description).toContain("Personal notes");

    const minimal = rows.find((r) => r.slug === "minimal");
    expect(minimal).toMatchObject({ title: "Minimal", description: null, is_valid: true });
  });

  it("flags malformed fixtures is_valid=false with a validation_error, never crashing the scan", async () => {
    const result = await reindexAll(sql, dir);
    const rows = await topics();

    const malformedSlugs = [
      "malformed-empty",
      "malformed-invalid-date",
      "malformed-invalid-time",
      "malformed-missing-title",
      "malformed-non-date-h2",
    ];
    for (const slug of malformedSlugs) {
      const row = rows.find((r) => r.slug === slug);
      expect(row).toBeDefined();
      expect(row!.is_valid).toBe(false);
      expect(row!.validation_error).not.toBeNull();
      expect(result.invalidFiles.map((f) => f.slug)).toContain(slug);
    }

    // valid fixtures still indexed alongside the malformed ones
    expect(rows.find((r) => r.slug === "bitcoin-node")!.is_valid).toBe(true);
  });

  it("indexes content directly under a date heading as a timestamp-less entry", async () => {
    await reindexAll(sql, dir);
    const rows = await entries();
    const loose = rows.find(
      (r) => r.slug === "bitcoin-node" && r.entry_date.toISOString().startsWith("2026-08-01") && r.entry_time === null,
    );
    expect(loose).toBeDefined();
    expect(loose!.content).toContain("Initial setup notes");
  });

  it("ignores headings and wikilinks inside fenced code blocks", async () => {
    await reindexAll(sql, dir);
    const rows = await entries();
    const morning = rows.find(
      (r) => r.slug === "bitcoin-node" && r.entry_time === "09:15:00",
    );
    expect(morning!.content).toContain("## this is not a heading");

    const links = await wikilinks();
    // the fenced echo "[[Not A Wikilink]]" must never produce a wikilink row
    expect(links.some((l) => l.target_slug === "not-a-wikilink")).toBe(false);
  });

  it("extracts wikilinks per entry with correct target slugs, deduped on collision", async () => {
    await reindexAll(sql, dir);
    const links = await wikilinks();
    const fromBitcoin = links.filter((l) => l.source_slug === "bitcoin-node");
    const targets = fromBitcoin.map((l) => l.target_slug);
    // [[Bitcoin]] lives in the description, not an entry — rendered but
    // never indexed (wikilinks.entry_id is NOT NULL, entry-precise only).
    expect(targets).not.toContain("bitcoin");
    expect(targets).toContain("tailscale");
    expect(targets).toContain("raspberry-pi");
    expect(targets).toContain("electrum-server");
    // "Tailscale" appears in two different entries — two rows expected,
    // not deduped across entries (wikilinks are entry-precise).
    expect(targets.filter((t) => t === "tailscale")).toHaveLength(2);
  });

  it("accent-insensitive slugs from multilingual titles/links", async () => {
    await reindexAll(sql, dir);
    const rows = await topics();
    const viaje = rows.find((r) => r.slug === "viaje-a-espana");
    expect(viaje!.title).toBe("Viaje a España");

    const links = await wikilinks();
    expect(links.some((l) => l.source_slug === "viaje-a-espana" && l.target_slug === "cosas-por-hacer")).toBe(true);
  });

  it("computes a file_hash matching the file's actual content", async () => {
    await reindexAll(sql, dir);
    const raw = await Bun.file(join(dir, "minimal.md")).text();
    const expected = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
    const [row] = await sql`SELECT file_hash FROM topics WHERE slug = 'minimal'`;
    expect(row!.file_hash).toBe(expected);
  });

  it("handles an empty topics directory cleanly", async () => {
    const empty = await mkdtemp(join(tmpdir(), "daybook-index-empty-"));
    try {
      const result = await reindexAll(sql, empty);
      expect(result.topicsIndexed).toBe(0);
      expect(result.entriesIndexed).toBe(0);
      expect(result.invalidFiles).toEqual([]);
      expect((await topics()).length).toBe(0);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("flags a filename that is not a valid slug, without crashing the scan", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "daybook-index-badname-"));
    try {
      await writeFile(join(scratch, "Not_A_Slug.md"), "# Whatever\n");
      await writeFile(join(scratch, "fine.md"), "# Fine\n");
      const result = await reindexAll(sql, scratch);
      expect(result.invalidFiles.map((f) => f.slug)).toContain("Not_A_Slug");
      const rows = await topics();
      expect(rows.find((r) => r.slug === "fine")!.is_valid).toBe(true);
      expect(rows.find((r) => r.slug === "Not_A_Slug")!.is_valid).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("drop + reindex reproduces the exact same index state", async () => {
    const first = await reindexAll(sql, dir);
    const [t1, e1, w1] = await Promise.all([topics(), entries(), wikilinks()]);

    // simulate "drop the DB": wipe every table, not just via reindexAll's
    // own internal DELETE FROM topics
    await sql`TRUNCATE topics, entries, wikilinks RESTART IDENTITY CASCADE`;

    const second = await reindexAll(sql, dir);
    const [t2, e2, w2] = await Promise.all([topics(), entries(), wikilinks()]);

    expect(t2).toEqual(t1);
    expect(e2).toEqual(e1);
    expect(w2).toEqual(w1);
    expect(second.topicsIndexed).toBe(first.topicsIndexed);
    expect(second.entriesIndexed).toBe(first.entriesIndexed);
    expect(second.invalidFiles).toEqual(first.invalidFiles);
  });

  it("full rescan is idempotent: reindexing twice in a row is a no-op on the data", async () => {
    await reindexAll(sql, dir);
    const before = await topics();
    await reindexAll(sql, dir);
    const after = await topics();
    expect(after).toEqual(before);
  });
});
