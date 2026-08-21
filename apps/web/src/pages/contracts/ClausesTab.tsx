import { useMemo, useState } from "react";
import { CLAUSE_CATEGORIES } from "@constructos/shared";
import { Badge, Button, Card, CardBody, EmptyState, Input } from "../../ui";
import { humanize } from "../format";
import type { EffectiveClause } from "./contractsShared";

/**
 * Effective clause register: the standard form's library overlaid with the
 * contract's Particular Conditions (#201-202). Filtering is client-side —
 * the whole register arrives with the contract detail.
 */
export default function ClausesTab({
  clauses,
  onRaiseEvent,
}: {
  clauses: EffectiveClause[];
  onRaiseEvent: (clauseRef: string) => void;
}) {
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    let items = clauses;
    if (category) items = items.filter((c) => c.category === category);
    const needle = search.trim().toLowerCase();
    if (needle) {
      items = items.filter(
        (c) =>
          c.clauseRef.toLowerCase().includes(needle) ||
          c.title.toLowerCase().includes(needle) ||
          c.summary.toLowerCase().includes(needle),
      );
    }
    return items;
  }, [clauses, category, search]);

  const chip = (active: boolean) =>
    active
      ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white"
      : "rounded-full bg-white px-3 py-1 text-xs font-medium text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button type="button" className={chip(category === "")} onClick={() => setCategory("")}>
          All
        </button>
        {CLAUSE_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className={chip(category === c)}
            onClick={() => setCategory((prev) => (prev === c ? "" : c))}
          >
            {humanize(c)}
          </button>
        ))}
        <div className="ml-auto w-64">
          <Input
            placeholder="Search clauses…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {clauses.length === 0 ? (
        <EmptyState
          title="No clause library for this form"
          hint="Bespoke contracts carry no standard-form clause model — deadlines must be tracked manually."
        />
      ) : filtered.length === 0 ? (
        <EmptyState title="No clauses match" hint="Try another category or search term." />
      ) : (
        <div className="space-y-3">
          {filtered.map((c) => (
            <Card key={c.clauseRef}>
              <CardBody>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-brand-700">
                        {c.clauseRef}
                      </span>
                      <span className="text-sm font-semibold text-ink-900">{c.title}</span>
                      {c.amended ? <Badge tone="violet">AMENDED</Badge> : null}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone="gray">{humanize(c.category)}</Badge>
                      {c.timeBarDays ? (
                        <Badge tone="red">{c.timeBarDays}-day notice</Badge>
                      ) : c.noticeRequired ? (
                        <Badge tone="amber">Notice required</Badge>
                      ) : null}
                      {c.noticeBy ? (
                        <Badge tone="blue">Notice by {humanize(c.noticeBy).toLowerCase()}</Badge>
                      ) : null}
                      {c.standingObligation ? (
                        <Badge tone="green">
                          Standing obligation — {humanize(c.standingObligation.party).toLowerCase()}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => onRaiseEvent(c.clauseRef)}>
                    Raise event under this clause
                  </Button>
                </div>

                <p className="mt-2 text-sm leading-relaxed text-ink-600">{c.summary}</p>

                {c.amended && c.amendment ? (
                  <div className="mt-3 rounded-md bg-violet-50 p-3 ring-1 ring-violet-100">
                    <button
                      type="button"
                      className="text-xs font-semibold uppercase tracking-wide text-violet-700 hover:text-violet-900"
                      onClick={() =>
                        setExpanded((m) => ({ ...m, [c.clauseRef]: !m[c.clauseRef] }))
                      }
                    >
                      Particular Condition {expanded[c.clauseRef] ? "▾" : "▸"}
                    </button>
                    {expanded[c.clauseRef] ? (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-violet-900">
                        {c.amendment}
                      </p>
                    ) : (
                      <p className="mt-1 truncate text-sm text-violet-800/70">{c.amendment}</p>
                    )}
                  </div>
                ) : null}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
