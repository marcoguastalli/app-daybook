import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type DayEntry, type TopicSummary } from "../api";
import { EntryCard } from "../components/EntryCard";
import { EntryEditor } from "../components/EntryEditor";
import { todayISO } from "../dates";

export function DailyView() {
  const [params] = useSearchParams();
  const date = params.get("date") ?? todayISO();
  const prefillTopic = params.get("topic") ?? "";

  const [entries, setEntries] = useState<DayEntry[]>([]);
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    const [day, topicList] = await Promise.all([api.day(date), api.topics()]);
    setEntries(day.entries);
    setTopics(topicList);
    setLoading(false);
  }, [date]);

  useEffect(() => {
    setLoading(true);
    refetch().catch(() => setLoading(false));
  }, [refetch]);

  const existingSlugs = useMemo(() => new Set(topics.map((t) => t.slug)), [topics]);

  return (
    <div className="daily">
      <div className="card capture-card">
        <h2>New entry · {date}</h2>
        <EntryEditor
          withTopic
          initialTopic={prefillTopic}
          submitLabel="Save entry"
          existingSlugs={existingSlugs}
          save={async ({ topicTitle, content }) => {
            await api.createEntry({ topicTitle, date, content });
            await refetch();
          }}
        />
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="muted">No entries on {date}.</p>
      ) : (
        <div className="masonry">
          {entries.map((entry) => (
            <EntryCard
              key={`${entry.slug}-${entry.time ?? "loose"}`}
              slug={entry.slug}
              topicTitle={entry.title}
              date={date}
              time={entry.time}
              content={entry.content}
              wikilinks={entry.wikilinks}
              existingSlugs={existingSlugs}
              onChanged={refetch}
            />
          ))}
        </div>
      )}
    </div>
  );
}
