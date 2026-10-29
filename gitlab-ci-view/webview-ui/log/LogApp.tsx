import { useVirtualizer } from "@tanstack/react-virtual";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { statusLabel } from "../../src/core/gitlab/status";
import { formatDuration } from "../../src/core/util/format";
import { type LogJobInfo, LogNotifications, LogRequests } from "../../src/shared/protocol";
import {
  findMatches,
  type SectionEntry,
  type Span,
  type TraceEntry,
  TraceParser,
  visibleEntries,
} from "../../src/shared/trace";
import { Banner } from "../components/Banner";
import { Codicon } from "../components/Codicon";
import { StatusIcon } from "../components/StatusIcon";
import { onNotification, request } from "../shared/messenger";

const LINE_HEIGHT = 18;

export function LogApp() {
  const parser = useRef(new TraceParser());
  /** Number of log characters received (to skip overlap between getInit and notifications). */
  const received = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<readonly TraceEntry[]>([]);
  const [job, setJob] = useState<LogJobInfo>();
  const [error, setError] = useState<string>();
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState(-1);

  useEffect(() => {
    const append = (start: number, text: string) => {
      const end = start + text.length;
      // Chunk already received, or arrived before getInit (getInit will include it).
      if (end <= received.current || start > received.current) return;
      parser.current.push(text.slice(received.current - start));
      received.current = end;
      setEntries(parser.current.snapshot());
    };
    let alive = true;
    let initialized = false;
    let errorNotified = false;
    const pending: { start: number; text: string }[] = [];
    const offs = [
      onNotification(LogNotifications.append, (chunk) => {
        if (initialized) append(chunk.start, chunk.text);
        else pending.push(chunk);
        setError(undefined);
      }),
      onNotification(LogNotifications.status, setJob),
      onNotification(LogNotifications.error, ({ message }) => {
        errorNotified = true;
        setError(message || undefined);
      }),
    ];
    void request(LogRequests.getInit).then((init) => {
      if (!alive) return;
      append(0, init.text);
      initialized = true;
      for (const chunk of pending) append(chunk.start, chunk.text);
      pending.length = 0;
      if (init.job) setJob((current) => current ?? init.job);
      if (!errorNotified && init.error) setError(init.error);
    });
    return () => {
      alive = false;
      for (const off of offs) off();
    };
  }, []);

  const visible = useMemo(() => visibleEntries(entries, toggled), [entries, toggled]);
  const matches = useMemo(() => findMatches(visible, query), [visible, query]);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 40,
  });

  useEffect(() => {
    if (follow && visible.length > 0) virtualizer.scrollToIndex(visible.length - 1, { align: "end" });
  }, [follow, visible.length, virtualizer]);

  const current = match >= 0 ? matches[match] : undefined;
  const jump = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    const i = (match + dir + matches.length) % matches.length;
    setMatch(i);
    setFollow(false);
    virtualizer.scrollToIndex(matches[i]!, { align: "center" });
  };
  const toggle = (id: string) =>
    setToggled((t) => {
      const next = new Set(t);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < LINE_HEIGHT * 2);
  };

  return (
    <div className="log-app">
      <header className="log-header">
        {job && (
          <>
            <StatusIcon status={job.status} allowFailure={job.allowFailure} />
            <strong>{job.name}</strong>
            <span className="muted">
              {statusLabel(job.status)}
              {job.duration !== undefined ? ` · ${formatDuration(job.duration)}` : ""}
            </span>
          </>
        )}
        <span className="spacer" />
        <input
          className="log-search"
          type="search"
          aria-label="Search log"
          placeholder="Search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setMatch(-1);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            jump(e.shiftKey ? -1 : 1);
          }}
        />
        {query && <span className="muted">{`${matches.length > 0 ? match + 1 : 0}/${matches.length}`}</span>}
        <button
          type="button"
          className="icon-button"
          title="Previous match"
          aria-label="Previous match"
          onClick={() => jump(-1)}
        >
          <Codicon name="arrow-up" />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Next match"
          aria-label="Next match"
          onClick={() => jump(1)}
        >
          <Codicon name="arrow-down" />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Follow log"
          aria-label="Follow log"
          aria-pressed={follow}
          onClick={() => setFollow((f) => !f)}
        >
          <Codicon name="fold-down" />
        </button>
        {job && (
          <button
            type="button"
            className="icon-button"
            title="Open in browser"
            aria-label="Open in browser"
            onClick={() => void request(LogRequests.openUrl, { url: job.webUrl })}
          >
            <Codicon name="link-external" />
          </button>
        )}
      </header>
      {error && <Banner kind="error">{error}</Banner>}
      <div className="log-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="log-lines" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const e = visible[v.index];
            if (!e) return null;
            const isCurrent = v.index === current;
            return (
              <div
                key={v.key}
                className={isCurrent ? "log-line current" : "log-line"}
                aria-current={isCurrent ? "true" : undefined}
                style={{ transform: `translateY(${v.start}px)`, paddingLeft: `${e.sections.length * 12 + 8}px` }}
              >
                {e.kind === "section" ? (
                  <SectionHeader
                    entry={e}
                    collapsed={e.collapsed !== toggled.has(e.id)}
                    onToggle={() => toggle(e.id)}
                  />
                ) : (
                  <Spans spans={e.spans} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  entry,
  collapsed,
  onToggle,
}: {
  readonly entry: SectionEntry;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button type="button" className="log-section" aria-expanded={!collapsed} onClick={onToggle}>
      <Codicon name={collapsed ? "chevron-right" : "chevron-down"} />
      <Spans spans={entry.spans.length > 0 ? entry.spans : [{ text: entry.name }]} />
      {entry.duration !== undefined && <span className="muted"> {formatDuration(entry.duration)}</span>}
    </button>
  );
}

function Spans({ spans }: { readonly spans: readonly Span[] }) {
  return (
    <>
      {spans.map((s, i) => (
        <span key={i} className={spanClass(s)} style={spanStyle(s)}>
          {s.text}
        </span>
      ))}
    </>
  );
}

function spanClass(s: Span): string | undefined {
  const classes = [
    s.fg?.startsWith("ansi-") ? `fg-${s.fg}` : "",
    s.bg?.startsWith("ansi-") ? `bg-${s.bg}` : "",
    s.bold ? "b" : "",
    s.italic ? "i" : "",
    s.underline ? "u" : "",
  ].filter(Boolean);
  return classes.length > 0 ? classes.join(" ") : undefined;
}

function spanStyle(s: Span): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (s.fg && !s.fg.startsWith("ansi-")) style.color = s.fg;
  if (s.bg && !s.bg.startsWith("ansi-")) style.backgroundColor = s.bg;
  return Object.keys(style).length > 0 ? style : undefined;
}
