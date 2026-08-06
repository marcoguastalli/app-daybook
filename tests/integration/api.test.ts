import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../src/server/app";
import { applySchema, createDbClient, type Sql } from "../../src/server/db/client";

const PASSWORD = "test-password";

let sql: Sql;
let dir: string;
let app: Hono;
let cookie: string;

beforeAll(async () => {
  sql = createDbClient({
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? 55432),
    database: process.env.POSTGRES_DB ?? "daybook_test",
    username: process.env.POSTGRES_USER ?? "postgres",
    password: process.env.POSTGRES_PASSWORD ?? "test",
  });
  await applySchema(sql);
  await sql`TRUNCATE topics, entries, wikilinks RESTART IDENTITY CASCADE`;
  dir = await mkdtemp(join(tmpdir(), "daybook-api-"));

  app = createApp({
    sql,
    topicsDir: dir,
    tz: "Europe/Madrid",
    appPassword: PASSWORD,
    sessionSecret: "test-secret",
    sessionTtlHours: 1,
    secureCookies: false,
    serveFrontend: false,
  });

  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await sql.end();
});

function get(path: string) {
  return app.request(path, { headers: { cookie } });
}

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("auth", () => {
  it("rejects a wrong password with 401 and no cookie", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sets an httpOnly SameSite=Strict session cookie on login", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  it("rejects every endpoint without a session except /health and login", async () => {
    const protectedRoutes: Array<[string, string]> = [
      ["GET", "/api/topics"],
      ["GET", "/api/topics/some-slug"],
      ["POST", "/api/entries"],
      ["PUT", "/api/topics/x/entries/2026-01-01/10:00"],
      ["DELETE", "/api/topics/x/entries/2026-01-01/10:00"],
      ["GET", "/api/days/2026-01-01"],
      ["GET", "/api/search?q=x"],
      ["GET", "/api/autocomplete/topics?q=x"],
      ["POST", "/api/admin/reindex"],
      ["GET", "/api/admin/status"],
      ["POST", "/api/auth/logout"],
      ["GET", "/docs"],
      ["GET", "/docs/openapi.json"],
    ];
    for (const [method, path] of protectedRoutes) {
      const res = await app.request(path, { method });
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 401`);
    }
    expect((await app.request("/health")).status).toBe(200);
  });

  it("a garbage or tampered cookie is rejected", async () => {
    const res = await app.request("/api/topics", {
      headers: { cookie: "daybook_session=abc.def" },
    });
    expect(res.status).toBe(401);
  });
});

describe("entries + topics + days", () => {
  it("POST /api/entries creates the topic file with # Title and returns the natural key", async () => {
    const res = await send("POST", "/api/entries", {
      topicTitle: "Bitcoin Node",
      date: "2026-08-06",
      content: "first entry, see [[Tailscale]]",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slug).toBe("bitcoin-node");
    expect(body.date).toBe("2026-08-06");
    expect(body.time).toMatch(/^\d{2}:\d{2}$/);

    const raw = await Bun.file(join(dir, "bitcoin-node.md")).text();
    expect(raw.startsWith("# Bitcoin Node\n")).toBe(true);
    expect(raw).toContain("## 2026-08-06");
    expect(raw).toContain("first entry");
  });

  it("a second same-minute entry appends into the same block", async () => {
    const res = await send("POST", "/api/entries", {
      topicTitle: "Bitcoin Node",
      date: "2026-08-06",
      content: "second same-minute entry",
    });
    expect(res.status).toBe(201);
    const raw = await Bun.file(join(dir, "bitcoin-node.md")).text();
    expect(raw).toContain("first entry");
    expect(raw).toContain("second same-minute entry");
  });

  it("existing # Title wins over a differently-cased topicTitle", async () => {
    const res = await send("POST", "/api/entries", {
      topicTitle: "BITCOIN node",
      date: "2026-08-05",
      content: "casing variant",
    });
    expect(res.status).toBe(201);
    expect((await res.json()).slug).toBe("bitcoin-node");
    const raw = await Bun.file(join(dir, "bitcoin-node.md")).text();
    expect(raw.startsWith("# Bitcoin Node\n")).toBe(true);
  });

  it("rejects a symbols-only topic title with 400", async () => {
    const res = await send("POST", "/api/entries", {
      topicTitle: "!!!",
      date: "2026-08-06",
      content: "x",
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/topics lists entry count and last entry date", async () => {
    const res = await get("/api/topics");
    expect(res.status).toBe(200);
    const rows = await res.json();
    const bitcoin = rows.find((r: { slug: string }) => r.slug === "bitcoin-node");
    expect(bitcoin).toMatchObject({
      title: "Bitcoin Node",
      isValid: true,
      lastEntryDate: "2026-08-06",
    });
    expect(bitcoin.entryCount).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/topics/:slug returns entries descending with per-entry wikilinks and backlinks", async () => {
    await send("POST", "/api/entries", {
      topicTitle: "Homelab",
      date: "2026-08-06",
      content: "linking to [[Bitcoin Node]] from here",
    });

    const res = await get("/api/topics/bitcoin-node");
    expect(res.status).toBe(200);
    const topic = await res.json();
    expect(topic.title).toBe("Bitcoin Node");
    expect(topic.entries[0]!.date >= topic.entries.at(-1)!.date).toBe(true);
    const withLink = topic.entries.find((e: { wikilinks: string[] }) =>
      e.wikilinks.includes("tailscale"),
    );
    expect(withLink).toBeDefined();
    expect(topic.backlinks).toEqual([
      { sourceSlug: "homelab", sourceTitle: "Homelab", date: "2026-08-06", time: expect.any(String) },
    ]);
  });

  it("GET /api/days/:date returns that day's entries across topics", async () => {
    const res = await get("/api/days/2026-08-06");
    expect(res.status).toBe(200);
    const day = await res.json();
    const slugs = day.entries.map((e: { slug: string }) => e.slug);
    expect(slugs).toContain("bitcoin-node");
    expect(slugs).toContain("homelab");
  });

  it("GET /api/days with a bad date is 400; unknown topic is 404; bad slug is 400", async () => {
    expect((await get("/api/days/2026-13-99")).status).toBe(400);
    expect((await get("/api/topics/never-created")).status).toBe(404);
    expect((await get("/api/topics/Not_A_Slug")).status).toBe(400);
  });
});

describe("edit and delete with the 409 contracts", () => {
  it("PUT edits an entry's content in file and index", async () => {
    const create = await send("POST", "/api/entries", {
      topicTitle: "Edit Target",
      date: "2026-07-01",
      content: "original content",
    });
    const { slug, date, time } = await create.json();

    const res = await send("PUT", `/api/topics/${slug}/entries/${date}/${time}`, {
      content: "rewritten content",
    });
    expect(res.status).toBe(200);

    const topic = await (await get(`/api/topics/${slug}`)).json();
    expect(topic.entries[0]!.content).toBe("rewritten content");
    expect(await Bun.file(join(dir, `${slug}.md`)).text()).toContain("rewritten content");
  });

  it("PUT after an external edit returns 409 stale; reindex + retry succeeds", async () => {
    const create = await send("POST", "/api/entries", {
      topicTitle: "Stale Check",
      date: "2026-07-02",
      content: "app-written",
    });
    const { slug, date, time } = await create.json();

    const path = join(dir, `${slug}.md`);
    await writeFile(path, (await Bun.file(path).text()) + "\nexternal vim edit\n");

    const stale = await send("PUT", `/api/topics/${slug}/entries/${date}/${time}`, {
      content: "should be refused",
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toContain("reindex");

    expect((await send("POST", "/api/admin/reindex")).status).toBe(200);
    const retry = await send("PUT", `/api/topics/${slug}/entries/${date}/${time}`, {
      content: "accepted after reindex",
    });
    expect(retry.status).toBe(200);
  });

  // NB: this passes even against the old Bun.file()-based reader — the bug it
  // documents only reproduces over a Docker bind mount, where a cached stat
  // size truncates the read. The real guard is tests/e2e/conflicts.spec.ts.
  it("detects an external edit made by another process", async () => {
    const create = await send("POST", "/api/entries", {
      topicTitle: "External Process",
      date: "2026-07-10",
      content: "app-written",
    });
    const { slug, date, time } = await create.json();
    const path = join(dir, `${slug}.md`);

    // A separate process, like vim on the server — NOT this process, whose
    // own writes would refresh any in-process file cache.
    Bun.spawnSync(["sh", "-c", `printf '\\nexternal vim edit\\n' >> ${path}`]);

    const res = await send("PUT", `/api/topics/${slug}/entries/${date}/${time}`, {
      content: "must be refused",
    });
    expect(res.status).toBe(409);
    // the external edit must still be on disk, untouched
    expect(await Bun.file(path).text()).toContain("external vim edit");
  });

  it("entries under duplicated headings are read-only: PUT/DELETE 409, POST still allowed", async () => {
    await writeFile(
      join(dir, "dup-topic.md"),
      "# Dup Topic\n\n## 2026-06-01\n\n### 10:00\n\nfirst\n\n## 2026-06-01\n\n### 09:00\n\nsecond\n",
    );
    await send("POST", "/api/admin/reindex");

    const put = await send("PUT", "/api/topics/dup-topic/entries/2026-06-01/10:00", {
      content: "nope",
    });
    expect(put.status).toBe(409);
    expect((await put.json()).error).toContain("duplicate headings");

    const del = await send("DELETE", "/api/topics/dup-topic/entries/2026-06-01/09:00");
    expect(del.status).toBe(409);

    const post = await send("POST", "/api/entries", {
      topicTitle: "Dup Topic",
      date: "2026-06-01",
      content: "adding a block breaks no invariant",
    });
    expect(post.status).toBe(201);
  });

  it("DELETE removes empty headings; the topic file survives with # Title only", async () => {
    const create = await send("POST", "/api/entries", {
      topicTitle: "Delete Target",
      date: "2026-07-03",
      content: "only entry",
    });
    const { slug, date, time } = await create.json();

    const res = await send("DELETE", `/api/topics/${slug}/entries/${date}/${time}`);
    expect(res.status).toBe(200);

    const raw = await Bun.file(join(dir, `${slug}.md`)).text();
    expect(raw).toBe("# Delete Target\n");
    const topic = await (await get(`/api/topics/${slug}`)).json();
    expect(topic.entries).toEqual([]);
  });

  it("PUT on a nonexistent entry is 404", async () => {
    const res = await send("PUT", "/api/topics/bitcoin-node/entries/2026-07-04/23:59", {
      content: "x",
    });
    expect(res.status).toBe(404);
  });

  it("editing a timestamp-less external entry keeps it timestamp-less", async () => {
    await writeFile(
      join(dir, "loose-topic.md"),
      "# Loose Topic\n\n## 2026-06-02\n\nexternal loose note\n",
    );
    await send("POST", "/api/admin/reindex");

    const res = await send("PUT", "/api/topics/loose-topic/entries/2026-06-02/-", {
      content: "edited loose note",
    });
    expect(res.status).toBe(200);
    const raw = await Bun.file(join(dir, "loose-topic.md")).text();
    expect(raw).toContain("edited loose note");
    expect(raw).not.toContain("###");
  });
});

describe("search + autocomplete", () => {
  it("finds content full-text, accent-insensitively, with highlighted snippets", async () => {
    await send("POST", "/api/entries", {
      topicTitle: "Viaje Notes",
      date: "2026-08-03",
      content: "Perché scriviamo appunti multilingua a Málaga",
    });

    const res = await get("/api/search?q=perche");
    expect(res.status).toBe(200);
    const body = await res.json();
    const hit = body.entries.find((e: { slug: string }) => e.slug === "viaje-notes");
    expect(hit).toBeDefined();
    expect(hit.snippet).toContain("<mark>");
  });

  it("matches typo'd topic titles via trigram (spec example: bitcon)", async () => {
    const res = await get("/api/search?q=bitcon");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topics.map((t: { slug: string }) => t.slug)).toContain("bitcoin-node");
  });

  it("multilingual content matches accent-insensitively in both directions", async () => {
    await send("POST", "/api/entries", {
      topicTitle: "Multilingual",
      date: "2026-08-02",
      content: "English words next to añadir and caffè",
    });
    // accent-less query finds accented content…
    const plain = await (await get("/api/search?q=anadir")).json();
    expect(plain.entries.some((e: { slug: string }) => e.slug === "multilingual")).toBe(true);
    // …and an accented query finds it too
    const accented = await (await get("/api/search?q=caff%C3%A8")).json();
    expect(accented.entries.some((e: { slug: string }) => e.slug === "multilingual")).toBe(true);
  });

  it("suggests topics from a title prefix", async () => {
    const res = await get("/api/autocomplete/topics?q=bitcoi");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions.map((s: { slug: string }) => s.slug)).toContain("bitcoin-node");
  });

  it("search without q is 400; empty autocomplete q returns empty suggestions", async () => {
    expect((await get("/api/search")).status).toBe(400);
    const res = await get("/api/autocomplete/topics?q=");
    expect((await res.json()).suggestions).toEqual([]);
  });
});

describe("admin + docs", () => {
  it("reindex returns stats and status reflects them", async () => {
    const res = await send("POST", "/api/admin/reindex");
    expect(res.status).toBe(200);
    const stats = await res.json();
    expect(stats.topicsIndexed).toBeGreaterThan(0);
    expect(typeof stats.durationMs).toBe("number");

    const status = await (await get("/api/admin/status")).json();
    expect(status.lastReindex.topicsIndexed).toBe(stats.topicsIndexed);
    expect(status.topics).toBeGreaterThan(0);
    expect(status.entries).toBeGreaterThan(0);
  });

  it("serves the OpenAPI spec and Swagger UI behind the session", async () => {
    const spec = await get("/docs/openapi.json");
    expect(spec.status).toBe(200);
    const doc = await spec.json();
    expect(Object.keys(doc.paths)).toContain("/api/entries");

    const ui = await get("/docs");
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("swagger");
  });

  it("logout clears the cookie", async () => {
    const res = await send("POST", "/api/auth/logout");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
