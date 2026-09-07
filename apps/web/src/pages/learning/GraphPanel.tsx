/**
 * THE LESSON'S EDGES (#992).
 *
 * `evidenceRefs` is a list of strings somebody typed. This panel shows the
 * VERIFIED version of the same claim: every record reference looked up in the
 * table that owns it, every person who can be asked about the lesson, the
 * vocabulary it is filed under, and the lessons it points at.
 *
 * An unresolvable reference is rendered, not hidden. A broken pointer in a
 * lessons register is a finding — it usually means the record was deleted, or
 * that the reference was never right — and quietly dropping it would leave the
 * register looking better evidenced than it is.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Badge, Button, Card, CardBody, Spinner } from "../../ui";
import {
  EDGE_ROLE_LABEL,
  LoadError,
  NoteCard,
  SectionTitle,
  errorMessage,
  fmtInt,
  label,
  type LessonEdge,
  type LessonEdgeKind,
  type LessonGraph,
} from "./learningShared";

const KIND_ORDER: Array<{ key: LessonEdgeKind; title: string; hint: string }> = [
  {
    key: "record",
    title: "Records",
    hint: "What the lesson came out of, what evidences it, and what it has been applied to.",
  },
  {
    key: "person",
    title: "People",
    hint: "Who wrote it, who validated it, who has applied it — the people who can be asked.",
  },
  { key: "tag", title: "Vocabulary", hint: "Normalised, so the register has one term per idea." },
  { key: "lesson", title: "Other lessons", hint: "Supersession, and lessons that read alike." },
];

function EdgeRow({ edge }: { edge: LessonEdge }) {
  return (
    <li className="flex flex-wrap items-baseline gap-2 border-t border-ink-100 px-1 py-1.5 text-xs first:border-t-0">
      <Badge tone={edge.verified === 1 ? "gray" : "red"}>
        {EDGE_ROLE_LABEL[edge.role] ?? label(edge.role)}
      </Badge>
      <span className="font-medium text-ink-800">
        {edge.targetLabel || edge.targetId}
      </span>
      <span className="text-ink-400">{label(edge.targetType)}</span>
      <span className="font-mono text-[10px] text-ink-400">{edge.targetId}</span>
      {edge.verified === 0 ? (
        <span className="text-red-700">
          unverified — no such record was found in this company
        </span>
      ) : null}
      {edge.recordLinkId ? (
        <span className="text-[10px] text-emerald-700" title="Mirrored into record_links">
          linked both ways
        </span>
      ) : null}
    </li>
  );
}

export default function GraphPanel({
  lessonId,
  canRebuild,
}: {
  lessonId: string;
  canRebuild: boolean;
}) {
  const [graph, setGraph] = useState<LessonGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGraph(await api.get<LessonGraph>(`/api/v1/learning/lessons/${lessonId}/graph`));
    } catch (err) {
      setGraph(null);
      setError(errorMessage(err, "Failed to load the lesson's edges"));
    } finally {
      setLoading(false);
    }
  }, [lessonId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function rebuild() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.post<{ inserted: number; deleted: number; unchanged: number }>(
        `/api/v1/learning/lessons/${lessonId}/graph/rebuild`,
        {},
      );
      setNotice(
        res.inserted === 0 && res.deleted === 0
          ? `Nothing changed: all ${res.unchanged} edge(s) already match the lesson. The projection is idempotent by design.`
          : `${res.inserted} edge(s) added, ${res.deleted} removed.`,
      );
      await load();
    } catch (err) {
      setNotice(errorMessage(err, "The rebuild was refused"));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !graph) return <Spinner label="Loading the lesson's edges…" />;
  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!graph) return null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <SectionTitle hint="Every record reference checked against the table that owns it. The verified ones are mirrored into record_links, so the record can answer the reverse question.">
          Knowledge graph
        </SectionTitle>

        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-600">
          <span>
            <span className="font-semibold tabular-nums text-ink-900">
              {fmtInt(graph.counts.total)}
            </span>{" "}
            edges
          </span>
          {graph.counts.unverified > 0 ? (
            <span className="font-semibold text-red-700">
              {fmtInt(graph.counts.unverified)} unverified
            </span>
          ) : null}
          {canRebuild ? (
            <Button size="sm" variant="secondary" onClick={() => void rebuild()} disabled={busy}>
              {busy ? "Rebuilding…" : "Rebuild edges"}
            </Button>
          ) : null}
        </div>

        <NoteCard note={graph.reason} />
        {notice ? <NoteCard note={notice} tone="brand" /> : null}

        {KIND_ORDER.map(({ key, title, hint }) => {
          const edges = graph.byKind[key] ?? [];
          if (edges.length === 0) return null;
          return (
            <div key={key}>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{title}</p>
              <p className="mb-1 text-[11px] text-ink-400">{hint}</p>
              <ul>
                {edges.map((e) => (
                  <EdgeRow key={e.id} edge={e} />
                ))}
              </ul>
            </div>
          );
        })}

        {graph.counts.total === 0 ? (
          <p className="text-xs text-ink-400">
            Resolvable record types: {graph.resolvableTypes.map((t) => label(t)).join(", ")}.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
