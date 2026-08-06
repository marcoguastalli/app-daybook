import { useEffect, useRef, useState } from "react";
import { api, classify409 } from "../api";
import { renderMarkdown } from "../markdown";

interface Suggestion {
  slug: string;
  title: string;
}

interface EntryEditorProps {
  /** Show the topic autocomplete field (quick-capture); edits omit it. */
  withTopic?: boolean;
  initialTopic?: string;
  initialContent?: string;
  submitLabel: string;
  existingSlugs?: Set<string>;
  onCancel?: () => void;
  /** Throws ApiError on failure; both 409 flows are handled here. */
  save: (args: { topicTitle: string; content: string }) => Promise<void>;
}

type SaveError =
  | { kind: "stale" | "duplicate" | "other"; message: string }
  | null;

export function EntryEditor({
  withTopic = false,
  initialTopic = "",
  initialContent = "",
  submitLabel,
  existingSlugs,
  onCancel,
  save,
}: EntryEditorProps) {
  const [topicTitle, setTopicTitle] = useState(initialTopic);
  const [content, setContent] = useState(initialContent);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [error, setError] = useState<SaveError>(null);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!withTopic || topicTitle.trim() === "" || !showSuggestions) {
      setSuggestions([]);
      return;
    }
    clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      try {
        const res = await api.autocomplete(topicTitle.trim());
        setSuggestions(res.suggestions);
      } catch {
        setSuggestions([]);
      }
    }, 150);
    return () => clearTimeout(debounce.current);
  }, [topicTitle, withTopic, showSuggestions]);

  const doSave = async () => {
    if (busy) return;
    if (withTopic && topicTitle.trim() === "") {
      setError({ kind: "other", message: "topic is required" });
      return;
    }
    if (content.trim() === "") {
      setError({ kind: "other", message: "content is empty" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await save({ topicTitle: topicTitle.trim(), content });
      if (withTopic) {
        setContent("");
      }
    } catch (err) {
      const kind = classify409(err) ?? "other";
      setError({ kind, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const reindexAndRetry = async () => {
    setBusy(true);
    try {
      await api.reindex();
    } finally {
      setBusy(false);
    }
    await doSave();
  };

  return (
    <div className="editor">
      {withTopic && (
        <div className="editor-topic">
          <input
            type="text"
            placeholder="Topic (existing or new)"
            value={topicTitle}
            onChange={(e) => {
              setTopicTitle(e.target.value);
              setShowSuggestions(true);
            }}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          />
          {showSuggestions && suggestions.length > 0 && (
            <ul className="suggestions">
              {suggestions.map((s) => (
                <li key={s.slug}>
                  <button
                    type="button"
                    onMouseDown={() => {
                      setTopicTitle(s.title);
                      setShowSuggestions(false);
                    }}
                  >
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="editor-panes">
        <textarea
          placeholder="Write markdown… [[Wikilinks]] link topics"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={6}
        />
        <div
          className="md editor-preview"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content, existingSlugs) }}
        />
      </div>

      {error && (
        <div className={`editor-error ${error.kind}`}>
          {error.kind === "stale" && (
            <>
              <p>
                The topic file changed on disk since it was last indexed (external edit).
                Reindexing refreshes the index, then the save is retried.
              </p>
              <button type="button" onClick={reindexAndRetry} disabled={busy}>
                Reindex and retry
              </button>
            </>
          )}
          {error.kind === "duplicate" && (
            <p>
              This entry sits under duplicated headings in the file, so the app cannot
              edit it safely — retrying will not help. Normalize the file externally
              (e.g. with vim), then reindex from the Admin view.
            </p>
          )}
          {error.kind === "other" && <p>{error.message}</p>}
        </div>
      )}

      <div className="editor-actions">
        <button type="button" onClick={doSave} disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
