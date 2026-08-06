import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type TopicSummary } from "../api";

export function TopicsView() {
  const [topics, setTopics] = useState<TopicSummary[] | null>(null);

  useEffect(() => {
    api.topics().then(setTopics).catch(() => setTopics([]));
  }, []);

  if (!topics) return <p className="muted">Loading…</p>;
  if (topics.length === 0) return <p className="muted">No topics yet — write a first entry in the daily view.</p>;

  return (
    <div className="topics-list">
      <h1>Topics</h1>
      <div className="masonry">
        {topics.map((t) => (
          <Link key={t.slug} to={`/topic/${t.slug}`} className="card topic-card">
            <h2>{t.title}</h2>
            <p className="muted">
              {t.entryCount} entries
              {t.lastEntryDate && ` · last ${t.lastEntryDate}`}
            </p>
            {!t.isValid && <p className="invalid-banner">invalid file</p>}
          </Link>
        ))}
      </div>
    </div>
  );
}
