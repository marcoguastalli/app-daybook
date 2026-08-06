import { useEffect, useState } from "react";
import { api, type AdminStatus } from "../api";

export function AdminView() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => api.adminStatus().then(setStatus);

  useEffect(() => {
    refresh();
  }, []);

  const reindex = async () => {
    setBusy(true);
    try {
      await api.reindex();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <p className="muted">Loading…</p>;

  return (
    <div className="admin">
      <h1>Admin</h1>

      <div className="card">
        <h2>Index</h2>
        <p>
          {status.topics} topics · {status.entries} entries indexed
        </p>
        <button type="button" onClick={reindex} disabled={busy}>
          {busy ? "Reindexing…" : "Reindex now"}
        </button>
        {status.lastReindex ? (
          <p className="muted">
            Last full reindex: {new Date(status.lastReindex.indexedAt).toLocaleString()} ·{" "}
            {Math.round(status.lastReindex.durationMs)} ms · {status.lastReindex.topicsIndexed}{" "}
            topics, {status.lastReindex.entriesIndexed} entries
          </p>
        ) : (
          <p className="muted">No full reindex since the app started.</p>
        )}
        <p className="muted">
          Edited files with vim? Reindexing rescans the whole topics directory — safe at any
          moment, the markdown files are always the source of truth.
        </p>
      </div>

      <div className="card">
        <h2>Invalid files</h2>
        {status.invalidFiles.length === 0 ? (
          <p className="muted">None — all topic files parse cleanly.</p>
        ) : (
          <ul className="invalid-list">
            {status.invalidFiles.map((f) => (
              <li key={f.slug}>
                <code>{f.slug}.md</code> — {f.error}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
