export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TopicSummary {
  slug: string;
  title: string;
  entryCount: number;
  lastEntryDate: string | null;
  isValid: boolean;
  validationError: string | null;
}

export interface TopicEntry {
  date: string;
  time: string | null;
  content: string;
  wikilinks: string[];
}

export interface Backlink {
  sourceSlug: string;
  sourceTitle: string;
  date: string;
  time: string | null;
}

export interface TopicDetail {
  slug: string;
  title: string;
  description: string | null;
  isValid: boolean;
  validationError: string | null;
  entries: TopicEntry[];
  backlinks: Backlink[];
}

export interface DayEntry {
  slug: string;
  title: string;
  time: string | null;
  content: string;
  wikilinks: string[];
}

export interface ReindexResult {
  topicsIndexed: number;
  entriesIndexed: number;
  invalidFiles: { slug: string; error: string }[];
  durationMs: number;
  indexedAt: string;
}

export interface SearchResult {
  query: string;
  topics: { slug: string; title: string }[];
  entries: {
    slug: string;
    title: string;
    date: string;
    time: string | null;
    snippet: string; // raw text fragment with <mark> tags from ts_headline
  }[];
}

export interface AdminStatus {
  lastReindex: ReindexResult | null;
  topics: number;
  entries: number;
  invalidFiles: { slug: string; error: string }[];
}

async function request<T>(path: string, init?: RequestInit, skip401Redirect = false): Promise<T> {
  const res = await fetch(path, init);
  if (res.status === 401 && !skip401Redirect) {
    window.location.href = "/login";
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // non-JSON error body: keep statusText
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  login: (password: string) =>
    request<{ ok: true }>("/api/auth/login", json({ password }), true),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  topics: () => request<TopicSummary[]>("/api/topics"),
  topic: (slug: string) => request<TopicDetail>(`/api/topics/${slug}`),
  day: (date: string) => request<{ date: string; entries: DayEntry[] }>(`/api/days/${date}`),

  createEntry: (body: { topicTitle: string; date: string; content: string }) =>
    request<{ slug: string; date: string; time: string }>("/api/entries", json(body)),
  updateEntry: (slug: string, date: string, time: string | null, content: string) =>
    request<{ slug: string }>(`/api/topics/${slug}/entries/${date}/${time ?? "-"}`, {
      ...json({ content }),
      method: "PUT",
    }),
  deleteEntry: (slug: string, date: string, time: string | null) =>
    request<{ deleted: true }>(`/api/topics/${slug}/entries/${date}/${time ?? "-"}`, {
      method: "DELETE",
    }),

  autocomplete: (q: string) =>
    request<{ suggestions: { slug: string; title: string }[] }>(
      `/api/autocomplete/topics?q=${encodeURIComponent(q)}`,
    ),
  search: (q: string) => request<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`),

  reindex: () => request<ReindexResult>("/api/admin/reindex", { method: "POST" }),
  adminStatus: () => request<AdminStatus>("/api/admin/status"),
};

/** The two 409 contracts need different UI: stale index is fixable with a
 *  one-click reindex+retry, duplicate headings only externally (vim). */
export function classify409(err: unknown): "stale" | "duplicate" | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  return err.message.includes("duplicate headings") ? "duplicate" : "stale";
}
