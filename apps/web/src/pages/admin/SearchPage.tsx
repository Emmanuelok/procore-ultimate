/**
 * Company-wide search (cross-package contract §3.3, Vol I §0.3 #74).
 *
 * The same endpoint the ⌘K palette uses, given a full page so a search can be
 * refined rather than skimmed: type filters drawn from what THIS caller may
 * actually search, results grouped by type, and an explicit statement of
 * coverage — which sources were consulted — so "no results" is never confused
 * with "you cannot see that tool".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Input,
  PageHeader,
  Skeleton,
  Stat,
} from "../../ui";
import { IconSearch } from "../../ui/icons";
import { formatRelativeTime } from "../../ui/data";
import { errorMessage, humanize, num, type SearchResponse, type SearchSourceInfo } from "./substrate";

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [types, setTypes] = useState<string[]>(
    (params.get("types") ?? "").split(",").filter(Boolean),
  );
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [sources, setSources] = useState<SearchSourceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api
      .get<{ items: SearchSourceInfo[] }>("/api/v1/search/sources")
      .then((res) => setSources(res.items))
      .catch(() => setSources([]));
  }, []);

  const run = useCallback(
    async (query: string, wanted: string[]) => {
      if (query.trim().length === 0) {
        setResult(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const search = new URLSearchParams({ q: query.trim(), limit: "50" });
        if (wanted.length > 0) search.set("types", wanted.join(","));
        setResult(await api.get<SearchResponse>(`/api/v1/search?${search.toString()}`));
      } catch (err) {
        setResult(null);
        setError(errorMessage(err, "Search failed"));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  /* Debounced so typing does not fan out a query per keystroke. */
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void run(q, types);
      const next: Record<string, string> = {};
      if (q.trim()) next["q"] = q.trim();
      if (types.length > 0) next["types"] = types.join(",");
      setParams(next, { replace: true });
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, types, run, setParams]);

  const grouped = useMemo(() => {
    const map = new Map<string, SearchResponse["items"]>();
    for (const item of result?.items ?? []) {
      const list = map.get(item.type) ?? [];
      list.push(item);
      map.set(item.type, list);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [result]);

  const sourceLabel = (type: string) =>
    sources?.find((s) => s.type === type)?.label ?? humanize(type);

  return (
    <div>
      <PageHeader
        title="Search"
        icon={IconSearch}
        subtitle="Every record type on the platform, with your permissions applied before a single row is returned"
      />

      <Card className="mb-4">
        <CardBody className="space-y-3">
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="RFI number, drawing, vendor, commitment, signal…"
            aria-label="Search query"
          />
          {sources === null ? (
            <Skeleton className="h-6 w-full" />
          ) : sources.length === 0 ? (
            <p className="text-2xs text-content-muted">
              No searchable sources are available to you.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setTypes([])}
                className={`rounded-full border px-2 py-0.5 text-2xs ${
                  types.length === 0
                    ? "border-accent-border bg-accent-subtle text-accent-text"
                    : "border-border-subtle text-content-muted"
                }`}
              >
                Everything
              </button>
              {sources.map((s) => {
                const on = types.includes(s.type);
                return (
                  <button
                    key={s.type}
                    type="button"
                    onClick={() =>
                      setTypes((prev) =>
                        prev.includes(s.type)
                          ? prev.filter((t) => t !== s.type)
                          : [...prev, s.type],
                      )
                    }
                    className={`rounded-full border px-2 py-0.5 text-2xs ${
                      on
                        ? "border-accent-border bg-accent-subtle text-accent-text"
                        : "border-border-subtle text-content-muted"
                    }`}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      <ErrorAlert message={error} onRetry={() => void run(q, types)} />

      {result ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Stat label="Matches" value={num(result.total)} hint={`${result.items.length} shown`} />
          <Stat label="Took" value={`${num(result.tookMs)} ms`} />
          <Stat
            label="Sources searched"
            value={num(result.coverage.length)}
            hint={
              result.coverage.length === 0
                ? "Nothing was searchable for you"
                : result.coverage.map(sourceLabel).join(", ")
            }
          />
        </div>
      ) : null}

      {loading && !result ? (
        <Skeleton className="h-40 w-full" />
      ) : !result ? (
        <EmptyState
          icon={IconSearch}
          title="Start typing"
          hint="Search runs across projects, field records, drawings, documents, commercial records, the directory, signals and obligations — whatever you have read access to."
        />
      ) : result.items.length === 0 ? (
        <EmptyState
          title={`Nothing matches "${q}"`}
          hint={
            result.coverage.length === 0
              ? "No sources were searchable for you — this is a permissions answer, not an empty database."
              : `Searched ${result.coverage.length} source(s): ${result.coverage.map(sourceLabel).join(", ")}.`
          }
        />
      ) : (
        <div className="space-y-4">
          {grouped.map(([type, items]) => (
            <Card key={type}>
              <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2">
                <h2 className="text-sm font-semibold text-content-strong">{sourceLabel(type)}</h2>
                <Badge tone="neutral">{num(items.length)}</Badge>
              </div>
              <ul className="divide-y divide-border-subtle">
                {items.map((item) => (
                  <li key={`${item.type}-${item.id}`}>
                    <Link
                      to={item.href}
                      className="flex items-start gap-3 px-4 py-2 transition-colors hover:bg-surface-raised"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-content-strong">
                          {item.title}
                        </span>
                        {item.subtitle ? (
                          <span className="block truncate text-xs text-content-muted">
                            {item.subtitle}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {item.status ? <Badge tone="neutral">{humanize(item.status)}</Badge> : null}
                        <span className="text-2xs text-content-subtle">
                          {item.updatedAt ? formatRelativeTime(item.updatedAt) : ""}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
