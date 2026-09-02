/**
 * Sheet naming review queue (#258). Every page the pipeline could not name
 * with confidence waits here with WHY: the candidates it saw and where,
 * whether it was a scan, an index page, or a duplicate of a number already
 * registered from the same set. A person confirms, merges, or discards.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Badge, Button, Card, CardBody, EmptyState, Field, Input, Select, useConfirm } from "../../ui";
import { IconCheckCircle } from "../../ui/icons";
import { api, ApiClientError } from "../../lib/api";
import { useResource } from "../../layouts/project/lib";
import { humanize } from "../format";
import { DISCIPLINES, pct, type ReviewItem } from "./drawingsShared";
import type { ListResponse, SheetListItem } from "./types";

interface Draft {
  number: string;
  title: string;
  discipline: string;
  area: string;
  targetSheetId: string;
}

export default function ReviewTab({ projectId, version, onChanged }: { projectId: string; version: number; onChanged: () => void }) {
  const queue = useResource<ListResponse<ReviewItem>>(`/api/v1/projects/${projectId}/sheets/review?_v=${version}`);
  const sheets = useResource<ListResponse<SheetListItem>>(`/api/v1/projects/${projectId}/sheets?pageSize=500&needsReview=0&_v=${version}`);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const items = queue.data?.items ?? [];

  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const it of items) {
        if (!next[it.id]) {
          next[it.id] = {
            number: it.detection.detectedNumber ?? it.detection.candidates?.[0]?.number ?? "",
            title: it.detection.detectedTitle ?? (it.title === "UNTITLED" ? "" : it.title),
            discipline: it.discipline,
            area: it.area ?? "",
            targetSheetId: it.duplicateOf?.id ?? "",
          };
        }
      }
      return next;
    });
  }, [items]);

  function setDraft(id: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { number: "", title: "", discipline: "other", area: "", targetSheetId: "" }), ...patch } }));
  }

  async function resolve(item: ReviewItem, action: "confirm" | "merge_into" | "discard") {
    const d = drafts[item.id];
    if (action === "discard") {
      const ok = await confirm({ title: `Discard page ${item.pageIndex != null ? item.pageIndex + 1 : "?"} of ${item.setName ?? "the set"}?`, description: "The page's revision, markups and pins are deleted. Use this for cover pages, indexes and blank scans — never for a real sheet.", confirmLabel: "Discard", tone: "danger" });
      if (!ok) return;
    }
    setBusy(`${action}:${item.id}`);
    setError(null);
    try {
      const body: Record<string, unknown> = { action };
      if (action === "confirm" && d) {
        body["number"] = d.number.trim();
        body["title"] = d.title.trim();
        body["discipline"] = d.discipline;
        body["area"] = d.area.trim() || null;
      }
      if (action === "merge_into" && d) body["targetSheetId"] = d.targetSheetId;
      const res = await api.post<Record<string, unknown>>(`/api/v1/projects/${projectId}/sheets/${item.id}/review`, body);
      setDone(action === "confirm" ? `Confirmed as ${String(res["number"])}${Number(res["linksResolved"] ?? 0) > 0 ? ` — ${res["linksResolved"]} unresolved callout(s) now point at it` : ""}.` : action === "merge_into" ? `Merged into ${String(res["number"])} as its next revision.` : "Page discarded.");
      queue.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The review action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {dialog}
      {error ? <Alert tone="danger" title="Refused" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {done ? <Alert tone="success" onDismiss={() => setDone(null)}>{done}</Alert> : null}
      {queue.error ? <Alert tone="danger" title="The review queue could not be loaded">{queue.error}</Alert> : null}
      {!queue.loading && items.length === 0 ? (
        <EmptyState icon={IconCheckCircle} title="Nothing awaits naming review" hint="Every registered sheet has a confirmed number and title. Pages the next upload cannot name will appear here with the candidates the pipeline saw." />
      ) : null}
      {items.map((item) => {
        const d = drafts[item.id] ?? { number: "", title: "", discipline: item.discipline, area: item.area ?? "", targetSheetId: "" };
        const candidates = item.detection.candidates ?? [];
        return (
          <Card key={item.id}>
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink-900">
                    <span className="font-mono">{item.number}</span>
                    <span className="ml-2 font-normal text-ink-500">page {item.pageIndex != null ? item.pageIndex + 1 : "?"} of {item.setName ?? "set"}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-ink-600">{item.reason}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {item.hasTextLayer === false ? <Badge tone="neutral" size="xs">scan — no text layer</Badge> : null}
                  {item.detection.isIndexPage ? <Badge tone="info" size="xs">drawing index</Badge> : null}
                  {item.detection.method ? <Badge tone="neutral" size="xs">{humanize(item.detection.method)} · {pct(item.detection.confidence)}</Badge> : null}
                  {item.duplicateOf ? <Badge tone="warning" size="xs">duplicate of {item.duplicateOf.number}</Badge> : null}
                  <Link to={item.id} className="text-xs font-medium text-brand-700 hover:underline">Open page →</Link>
                </div>
              </div>

              {candidates.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-2xs uppercase tracking-wide text-ink-400">Numbers seen</span>
                  {candidates.slice(0, 8).map((c) => (
                    <button key={c.number} type="button" onClick={() => setDraft(item.id, { number: c.number })} className={`rounded-full px-2 py-0.5 font-mono text-xs ring-1 ${d.number === c.number ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-700 ring-ink-200 hover:bg-ink-50"}`} title={`score ${c.score}${c.titleBlock ? " · in the title block" : ""}`}>
                      {c.number}
                      {c.titleBlock ? " ▣" : ""}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="grid gap-2 md:grid-cols-[140px_1fr_160px_140px_auto]">
                <Field label="Number">
                  <Input value={d.number} onChange={(e) => setDraft(item.id, { number: e.target.value })} placeholder="A-101" />
                </Field>
                <Field label="Title">
                  <Input value={d.title} onChange={(e) => setDraft(item.id, { title: e.target.value })} placeholder="FLOOR PLAN LEVEL 1" />
                </Field>
                <Field label="Discipline">
                  <Select value={d.discipline} onChange={(e) => setDraft(item.id, { discipline: e.target.value })}>
                    {DISCIPLINES.map((x) => (
                      <option key={x} value={x}>{humanize(x)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Area">
                  <Input value={d.area} onChange={(e) => setDraft(item.id, { area: e.target.value })} placeholder="optional" />
                </Field>
                <div className="flex items-end">
                  <Button size="sm" disabled={busy !== null || !d.number.trim() || !d.title.trim()} loading={busy === `confirm:${item.id}`} onClick={() => void resolve(item, "confirm")}>
                    Confirm
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-end gap-2 border-t border-ink-100 pt-2">
                <Field label="…or merge this page into an existing sheet as its next revision" className="min-w-72">
                  <Select value={d.targetSheetId} onChange={(e) => setDraft(item.id, { targetSheetId: e.target.value })}>
                    <option value="">Choose a sheet…</option>
                    {(sheets.data?.items ?? []).map((s) => (
                      <option key={s.id} value={s.id}>{s.number} — {s.title}</option>
                    ))}
                  </Select>
                </Field>
                <Button size="sm" variant="secondary" disabled={busy !== null || !d.targetSheetId} loading={busy === `merge_into:${item.id}`} onClick={() => void resolve(item, "merge_into")}>
                  Merge into
                </Button>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" disabled={busy !== null} loading={busy === `discard:${item.id}`} onClick={() => void resolve(item, "discard")}>
                  Discard page
                </Button>
              </div>
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}
