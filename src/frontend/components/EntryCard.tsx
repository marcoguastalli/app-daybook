import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, classify409 } from "../api";
import { interceptWikilinkClicks, renderMarkdown } from "../markdown";
import { EntryEditor } from "./EntryEditor";

interface EntryCardProps {
  slug: string;
  /** Set in the daily view: topic title as clickable label. */
  topicTitle?: string;
  date: string;
  time: string | null;
  content: string;
  wikilinks: string[]; // target slugs
  existingSlugs: Set<string>;
  onChanged: () => void;
  /** DOM id so search results can deep-link to this entry. */
  anchorId?: string;
}

export function EntryCard({
  slug,
  topicTitle,
  date,
  time,
  content,
  wikilinks,
  existingSlugs,
  onChanged,
  anchorId,
}: EntryCardProps) {
  const [editing, setEditing] = useState(false);
  const navigate = useNavigate();

  const remove = async () => {
    if (!window.confirm(`Delete this entry (${date} ${time ?? "no timestamp"})?`)) return;
    try {
      await api.deleteEntry(slug, date, time);
      onChanged();
    } catch (err) {
      const kind = classify409(err);
      if (kind === "stale") {
        if (window.confirm("The file changed on disk since last index. Reindex and retry the delete?")) {
          await api.reindex();
          await api.deleteEntry(slug, date, time);
          onChanged();
        }
      } else if (kind === "duplicate") {
        window.alert(
          "This entry sits under duplicated headings — the app cannot delete it safely. Normalize the file externally (vim), then reindex.",
        );
      } else {
        window.alert(err instanceof Error ? err.message : String(err));
      }
    }
  };

  return (
    <article className="card entry-card" id={anchorId}>
      <header className="entry-head">
        {topicTitle && (
          <Link className="entry-topic" to={`/topic/${slug}`}>
            {topicTitle}
          </Link>
        )}
        <span className="entry-time">{time ?? "—"}</span>
        <span className="entry-actions">
          <button type="button" className="ghost" onClick={() => setEditing(true)} title="Edit">
            ✎
          </button>
          <button type="button" className="ghost" onClick={remove} title="Delete">
            ✕
          </button>
        </span>
      </header>

      {editing ? (
        <EntryEditor
          initialContent={content}
          submitLabel="Save"
          existingSlugs={existingSlugs}
          onCancel={() => setEditing(false)}
          save={async ({ content: newContent }) => {
            await api.updateEntry(slug, date, time, newContent);
            setEditing(false);
            onChanged();
          }}
        />
      ) : (
        <div
          className="md"
          onClick={(e) => interceptWikilinkClicks(e, navigate)}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content, existingSlugs) }}
        />
      )}

      {wikilinks.length > 0 && !editing && (
        <footer className="chips">
          {wikilinks.map((target) =>
            existingSlugs.has(target) ? (
              <Link key={target} className="chip" to={`/topic/${target}`}>
                {target}
              </Link>
            ) : (
              <span key={target} className="chip missing" title="Topic does not exist yet">
                {target}
              </span>
            ),
          )}
        </footer>
      )}
    </article>
  );
}
