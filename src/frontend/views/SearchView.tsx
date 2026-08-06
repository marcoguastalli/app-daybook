import DOMPurify from "dompurify";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type SearchResult } from "../api";
import { entryAnchor } from "../dates";

/** Snippets are plain-text fragments from ts_headline: only <mark> survives. */
function sanitizeSnippet(snippet: string): string {
  return DOMPurify.sanitize(snippet, { ALLOWED_TAGS: ["mark"] });
}

export function SearchView() {
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (q.trim() === "") {
      setResult(null);
      return;
    }
    setLoading(true);
    api
      .search(q)
      .then(setResult)
      .finally(() => setLoading(false));
  }, [q]);

  if (q.trim() === "") return <p className="muted">Type a query in the search bar above.</p>;
  if (loading && !result) return <p className="muted">Searching…</p>;
  if (!result) return null;

  const empty = result.topics.length === 0 && result.entries.length === 0;

  return (
    <div className="search">
      <h1>
        Results for <em>{result.query}</em>
      </h1>

      {empty && <p className="muted">Nothing found. Accents and small typos are fine — try fewer words.</p>}

      {result.topics.length > 0 && (
        <section className="search-section">
          <h2 className="muted">Topics</h2>
          <div className="chips">
            {result.topics.map((t) => (
              <Link key={t.slug} className="chip" to={`/topic/${t.slug}`}>
                {t.title}
              </Link>
            ))}
          </div>
        </section>
      )}

      {result.entries.length > 0 && (
        <section className="search-section">
          <h2 className="muted">Entries</h2>
          <div className="masonry">
            {result.entries.map((e, i) => (
              <Link
                key={i}
                className="card search-hit"
                to={`/topic/${e.slug}#${entryAnchor(e.date, e.time)}`}
              >
                <header className="entry-head">
                  <span className="entry-topic">{e.title}</span>
                  <span className="entry-time">
                    {e.date}
                    {e.time && ` · ${e.time}`}
                  </span>
                </header>
                <p
                  className="snippet"
                  dangerouslySetInnerHTML={{ __html: sanitizeSnippet(e.snippet) }}
                />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
