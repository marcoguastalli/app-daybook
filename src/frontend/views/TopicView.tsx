import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type TopicDetail, type TopicSummary } from "../api";
import { EntryCard } from "../components/EntryCard";
import { entryAnchor } from "../dates";
import { interceptWikilinkClicks, renderMarkdown } from "../markdown";

export function TopicView() {
  const { slug } = useParams<{ slug: string }>();
  const [topic, setTopic] = useState<TopicDetail | null>(null);
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const refetch = useCallback(async () => {
    try {
      const [detail, topicList] = await Promise.all([api.topic(slug!), api.topics()]);
      setTopic(detail);
      setTopics(topicList);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? "Topic not found" : String(err));
    }
  }, [slug]);

  useEffect(() => {
    setTopic(null);
    refetch();
  }, [refetch]);

  // Search results deep-link to an entry (#e-<date>-<hhmm>): scroll to it
  // once the entries are rendered. The highlight uses a class, not :target —
  // SPA navigation (pushState) never updates the :target pseudo-class.
  useEffect(() => {
    if (!topic || !location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.add("targeted");
    return () => el.classList.remove("targeted");
  }, [topic, location.hash]);

  const existingSlugs = useMemo(() => new Set(topics.map((t) => t.slug)), [topics]);

  if (error) return <p className="muted">{error}</p>;
  if (!topic) return <p className="muted">Loading…</p>;

  const dates = [...new Set(topic.entries.map((e) => e.date))];
  const uniqueBacklinks = [...new Map(topic.backlinks.map((b) => [b.sourceSlug, b])).values()];

  return (
    <div className="topic">
      <header className="topic-head">
        <h1>{topic.title}</h1>
        <p className="muted">
          {topic.entries.length} entries · {dates.length} days
        </p>
        {!topic.isValid && (
          <p className="invalid-banner">
            This topic file is invalid: {topic.validationError} — fix it externally and reindex.
          </p>
        )}
        {topic.description && (
          <div
            className="md topic-description"
            onClick={(e) => interceptWikilinkClicks(e, navigate)}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(topic.description, existingSlugs) }}
          />
        )}
        {uniqueBacklinks.length > 0 && (
          <div className="backlinks">
            <span className="muted">Mentioned in:</span>
            <span className="chips">
              {uniqueBacklinks.map((b) => (
                <Link key={b.sourceSlug} className="chip" to={`/topic/${b.sourceSlug}`}>
                  {b.sourceTitle}
                </Link>
              ))}
            </span>
          </div>
        )}
      </header>

      {dates.map((date) => (
        <section key={date}>
          <h2 className="date-heading">{date}</h2>
          <div className="masonry">
            {topic.entries
              .filter((e) => e.date === date)
              .map((entry) => (
                <EntryCard
                  key={`${entry.date}-${entry.time ?? "loose"}`}
                  slug={topic.slug}
                  date={entry.date}
                  time={entry.time}
                  content={entry.content}
                  wikilinks={entry.wikilinks}
                  existingSlugs={existingSlugs}
                  onChanged={refetch}
                  anchorId={entryAnchor(entry.date, entry.time)}
                />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
