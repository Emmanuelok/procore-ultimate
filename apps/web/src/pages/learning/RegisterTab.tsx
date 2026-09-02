/**
 * The company-wide lesson register (#977, #992-993).
 *
 * DEFAULTS TO PUBLISHED, deliberately. `GET /learning/lessons` will happily
 * return drafts, submitted and rejected lessons, and a register view that
 * silently mixes them is how a company ends up believing it has learned
 * something it has only typed. The status filter is explicit, and any view
 * that is not the published register says so at the top.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LESSON_CATEGORIES } from "@constructos/shared";
import { api } from "../../lib/api";
import { Badge, Button, Card, CardBody, EmptyState, Field, Input, Select, Spinner, Table, Td, Th } from "../../ui";
import { formatDate } from "../format";
import LessonDrawer from "./LessonDrawer";
import {
  LoadError,
  NoteCard,
  SectionTitle,
  TagList,
  errorMessage,
  fmtInt,
  impactLabel,
  label,
  lessonStatusTone,
  parseTags,
  projectLabel,
  projectNameOf,
} from "./learningShared";
import type { LessonListRow, LessonStatus, ListResponse, ProjectRow } from "./learningShared";

const STATUSES: (LessonStatus | "")[] = [
  "published",
  "draft",
  "submitted",
  "validated",
  "rejected",
  "superseded",
  "",
];

interface Filters {
  status: string;
  category: string;
  phase: string;
  tags: string;
  originProject: string;
  impactMin: string;
  impactMax: string;
  q: string;
}

const EMPTY: Filters = {
  status: "published",
  category: "",
  phase: "",
  tags: "",
  originProject: "",
  impactMin: "",
  impactMax: "",
  q: "",
};

function buildQuery(f: Filters, page: number, pageSize: number): string {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  if (f.status) params.set("status", f.status);
  if (f.category) params.set("category", f.category);
  if (f.phase.trim()) params.set("phase", f.phase.trim());
  const tags = parseTags(f.tags);
  if (tags.length > 0) params.set("tags", tags.join(","));
  if (f.originProject) params.set("originProject", f.originProject);
  if (f.impactMin.trim() && Number.isFinite(Number(f.impactMin))) params.set("impactMin", f.impactMin.trim());
  if (f.impactMax.trim() && Number.isFinite(Number(f.impactMax))) params.set("impactMax", f.impactMax.trim());
  if (f.q.trim()) params.set("q", f.q.trim());
  return params.toString();
}

export default function RegisterTab({
  projects,
  canSupersede,
  focusLessonId,
  onFocusConsumed,
}: {
  projects: ProjectRow[] | null;
  canSupersede: boolean;
  focusLessonId: string | null;
  onFocusConsumed: () => void;
}) {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [rows, setRows] = useState<LessonListRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [openLessonId, setOpenLessonId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<LessonListRow>>(
        `/api/v1/learning/lessons?${buildQuery(applied, page, pageSize)}`,
      );
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      setRows(null);
      setError(errorMessage(err, "Failed to load the lesson register"));
    }
  }, [applied, page]);

  useEffect(() => {
    void load();
  }, [load]);

  /* The health tab hands a lesson over by id — open it and clear the handoff. */
  useEffect(() => {
    if (focusLessonId) {
      setOpenLessonId(focusLessonId);
      onFocusConsumed();
    }
  }, [focusLessonId, onFocusConsumed]);

  function apply(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setApplied(draft);
  }

  function reset() {
    setDraft(EMPTY);
    setApplied(EMPTY);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <SectionTitle hint="The whole company's register. Only published lessons are retrievable by the relevance engine or applicable to a record.">
            Filters
          </SectionTitle>
          <form onSubmit={apply} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Status">
                <Select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                  {STATUSES.map((s) => (
                    <option key={s || "any"} value={s}>
                      {s === "" ? "Any status (includes drafts)" : label(s)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Category">
                <Select
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                >
                  <option value="">Any category</option>
                  {LESSON_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {label(c)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Phase" hint="Exact match on the phase as written.">
                <Input
                  value={draft.phase}
                  onChange={(e) => setDraft({ ...draft, phase: e.target.value })}
                  placeholder="e.g. commissioning"
                  maxLength={60}
                />
              </Field>
              <Field label="Origin project">
                <Select
                  value={draft.originProject}
                  onChange={(e) => setDraft({ ...draft, originProject: e.target.value })}
                >
                  <option value="">Any project</option>
                  {(projects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {projectLabel(p)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Tags" hint="Comma separated; matches any of them.">
                <Input
                  value={draft.tags}
                  onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                  placeholder="mep-coordination, late-change"
                  maxLength={400}
                />
              </Field>
              <Field label="Impact from">
                <Input
                  type="number"
                  step="any"
                  value={draft.impactMin}
                  onChange={(e) => setDraft({ ...draft, impactMin: e.target.value })}
                />
              </Field>
              <Field label="Impact to">
                <Input
                  type="number"
                  step="any"
                  value={draft.impactMax}
                  onChange={(e) => setDraft({ ...draft, impactMax: e.target.value })}
                />
              </Field>
              <Field label="Free text" hint="Title, context, what happened, root cause, recommendation.">
                <Input
                  value={draft.q}
                  onChange={(e) => setDraft({ ...draft, q: e.target.value })}
                  placeholder="search the text"
                  maxLength={200}
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={reset}>
                Reset to published
              </Button>
              <Button type="submit">Apply filters</Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {applied.status !== "published" ? (
        <NoteCard
          tone="amber"
          note={
            applied.status === ""
              ? "This view is showing lessons in ANY status, including drafts and rejected ones. A draft is not organisational memory — it is not retrievable, cannot be applied, and must not be counted as part of the published register."
              : `This view is filtered to ${label(applied.status)} lessons only. Only published lessons are retrievable by the relevance engine or applicable to a record.`
          }
        />
      ) : null}

      {error ? (
        <LoadError message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <Spinner label="Loading the register…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No lesson matches these filters"
          hint={
            applied.status === "published"
              ? "The register defaults to published lessons. If lessons have been captured but not yet validated and published, widen the status filter to find them."
              : "Widen or reset the filters."
          }
          action={
            <Button variant="secondary" onClick={reset}>
              Reset to published
            </Button>
          }
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Lesson</Th>
                <Th>Category</Th>
                <Th>Phase</Th>
                <Th>Status</Th>
                <Th>Origin project</Th>
                <Th>Impact</Th>
                <Th>Applied</Th>
                <Th>Tags</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((l) => (
                <tr key={l.id} className="hover:bg-ink-50">
                  <Td>
                    <span className="font-mono text-xs text-ink-500">{l.number}</span>
                    <div className="font-medium text-ink-900">{l.title}</div>
                    <div className="text-xs text-ink-400">
                      {l.publishedAt ? `published ${formatDate(l.publishedAt)}` : `created ${formatDate(l.createdAt)}`}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Badge tone="blue">{label(l.category)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{l.phase ?? "—"}</Td>
                  <Td className="whitespace-nowrap">
                    <Badge tone={lessonStatusTone(l.status)}>{label(l.status)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{projectNameOf(projects, l.originProjectId)}</Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {impactLabel(l.impactValue, l.impactCurrency, l.impactDays)}
                  </Td>
                  <Td className="tabular-nums">
                    {l.applicationCount > 0 ? (
                      <span className="font-semibold text-emerald-700">{fmtInt(l.applicationCount)}</span>
                    ) : l.status === "published" ? (
                      <span className="text-xs font-medium text-red-600">never</span>
                    ) : (
                      <span className="text-xs text-ink-300">—</span>
                    )}
                  </Td>
                  <Td className="max-w-48">
                    <TagList tags={l.tags} />
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Button size="sm" variant="secondary" onClick={() => setOpenLessonId(l.id)}>
                      Inspect
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="flex items-center justify-between text-xs text-ink-500">
            <span>
              {fmtInt(total)} lesson{total === 1 ? "" : "s"} · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {openLessonId ? (
        <LessonDrawer
          lessonId={openLessonId}
          projects={projects}
          canSupersede={canSupersede}
          onClose={() => setOpenLessonId(null)}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  );
}
