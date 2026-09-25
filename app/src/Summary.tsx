import { Fragment, ReactNode, useEffect, useState } from "react";
import { api, Bootstrap, dateTime, MeetingDetail, on } from "./api";
import { Icon } from "./Brand";
import { ConfirmButton } from "./Menu";

// The summary stays collapsed in every meeting after the user collapses it once.
const COLLAPSED_KEY = "tinta-summary-collapsed";

/** Renders the small Markdown subset of a summary: paragraphs, `###` headings, `-` lists, and `**bold**`. */
function Markdown({ text }: { text: string }) {
  const inline = (line: string): ReactNode =>
    line.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
    );
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={blocks.length}>
        {list.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- ")) {
      list.push(line.slice(2));
      continue;
    }
    flush();
    if (!line) continue;
    if (line.startsWith("#")) blocks.push(<h3 key={blocks.length}>{line.replace(/^#+\s*/, "")}</h3>);
    else blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="summary-text">{blocks}</div>;
}

type Props = {
  detail: MeetingDetail;
  boot: Bootstrap | null;
  onError: (e: string) => void;
  onMessage: (m: string) => void;
};

export function SummaryPanel({ detail, boot, onError, onMessage }: Props) {
  const [fraction, setFraction] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "true");
  const toggle = () => {
    localStorage.setItem(COLLAPSED_KEY, String(!collapsed));
    setCollapsed(!collapsed);
  };
  const id = detail.meeting.id;
  const summary = detail.summary;
  const available = boot?.summaries.available ?? false;

  useEffect(() => {
    const subs = [
      on<{ event: string; id?: string; fraction?: number }>("engine", (e) => {
        if (e.event === "summary_progress" && (!e.id || e.id === id)) setFraction(Number(e.fraction));
      }),
      on<{ id: string; error: string | null }>("summary", (e) => {
        if (e.id !== id) return;
        setFraction(null);
        if (e.error) onError(`The summary failed: ${e.error}`);
      }),
    ];
    return () => subs.forEach((s) => s.then((u) => u()));
  }, [id]);

  const start = () => api.summarize(id).catch((e) => onError(String(e)));

  async function copy() {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(summary.content);
      onMessage("Copied the summary.");
    } catch (e) {
      onError(String(e));
    }
  }

  if (detail.summarizing) {
    return (
      <section className="panel summary-panel">
        <div className="column-head">
          <h2>Summary</h2>
        </div>
        <p className="small muted">Writing the summary from your notes and the transcript…</p>
        <div className={`meter-bar wide ${fraction === null ? "indeterminate" : ""}`}>
          <div style={fraction === null ? undefined : { transform: `scaleX(${Math.max(0.02, fraction)})` }} />
        </div>
      </section>
    );
  }

  if (!summary) {
    return (
      <section className="panel summary-panel empty">
        <div>
          <h2>Summary</h2>
          <p className="small muted">
            {available
              ? "Tinta can write a summary from your notes and the transcript with the Apple on-device model."
              : (boot?.summaries.reason ?? "The on-device model is not available.")}
          </p>
        </div>
        <button onClick={start} disabled={!available}>
          Write a summary
        </button>
      </section>
    );
  }

  return (
    <section className={`panel summary-panel ${collapsed ? "collapsed" : ""}`}>
      <div className="column-head">
        <button className="quiet collapse-toggle" onClick={toggle} aria-expanded={!collapsed}>
          <Icon name="chevron" size={14} />
          <h2>Summary</h2>
        </button>
        {!collapsed && (
          <span className="summary-actions">
            <button className="quiet" onClick={copy}>
              Copy
            </button>
            <button className="quiet" onClick={start} disabled={!available} title={available ? "" : boot?.summaries.reason}>
              Write again
            </button>
            <ConfirmButton
              label="Delete"
              question="Delete this summary?"
              confirm="Delete summary"
              onConfirm={() => api.deleteSummary(id).catch((e) => onError(String(e)))}
            />
          </span>
        )}
      </div>
      {!collapsed && (
        <>
      <Markdown text={summary.content} />
      <p className="small muted summary-note">
        {summary.written_by === "MCP client"
          ? `Changed by an MCP client, ${dateTime(summary.updated_at)}. Undo the change on the MCP screen.`
          : `Written by the ${summary.written_by}, ${dateTime(summary.updated_at)}.`}{" "}
        It can contain mistakes. Check it against the transcript.
      </p>
        </>
      )}
    </section>
  );
}
