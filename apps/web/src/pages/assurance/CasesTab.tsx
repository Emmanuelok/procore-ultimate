/**
 * Integrity cases and referral packs (spec Vol II Domain A #98, #100-101).
 *
 * A case is what turns a scatter of signals into something a person can hand
 * to somebody else: signals, reconciliations and evidence grouped, worked, and
 * exported as a Merkle-committed referral pack bound to the ledger head, with
 * a completeness statement naming what was left out.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { INTEGRITY_CASE_STATUSES, SIGNAL_SEVERITIES } from "@constructos/shared";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  downloadAuthenticated,
  severityTone,
  StatCard,
  truncateMiddle,
  type SignalRow,
} from "./assuranceShared";

interface CaseRow {
  id: string;
  reference: string;
  title: string;
  summary: string | null;
  status: string;
  severity: string;
  projectId: string | null;
  assignedTo: string | null;
  referralTarget: string | null;
  closedAt: string | null;
  closureReason: string | null;
  createdAt: string;
}

interface CaseItem {
  id: string;
  itemType: string;
  itemId: string | null;
  fromSeq: number | null;
  toSeq: number | null;
  note: string | null;
  createdAt: string;
}

interface PackRow {
  id: string;
  title: string;
  purpose: string;
  root: string;
  itemCount: number;
  sealSequence: number | null;
  generatedAt: string;
  statement?: string | null;
}

interface CaseDetail extends CaseRow {
  items: CaseItem[];
  signals: SignalRow[];
  packs: PackRow[];
}

function statusTone(status: string): "red" | "amber" | "green" | "gray" | "blue" {
  switch (status) {
    case "open":
      return "blue";
    case "investigating":
      return "amber";
    case "referred":
    case "substantiated":
      return "red";
    case "unsubstantiated":
    case "closed":
      return "gray";
    default:
      return "gray";
  }
}

export default function CasesTab() {
  const [items, setItems] = useState<CaseRow[] | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ title: "", summary: "", severity: "medium" });
  const [createError, setCreateError] = useState<string | null>(null);

  const [referTarget, setReferTarget] = useState("");
  const [packResult, setPackResult] = useState<{ root: string; statement: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: "50" });
      if (status) params.set("status", status);
      const res = await api.get<{ items: CaseRow[] }>(`/api/v1/integrity-cases?${params}`);
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load integrity cases");
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(row: CaseRow) {
    setDetail(null);
    setDetailError(null);
    setPackResult(null);
    setReferTarget(row.referralTarget ?? "");
    try {
      const res = await api.get<CaseDetail>(`/api/v1/integrity-cases/${row.id}`);
      setDetail(res);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Failed to load the case");
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCreateError(null);
    try {
      await api.post("/api/v1/integrity-cases", {
        title: form.title.trim(),
        ...(form.summary.trim() ? { summary: form.summary.trim() } : {}),
        severity: form.severity,
      });
      setCreateOpen(false);
      setForm({ title: "", summary: "", severity: "medium" });
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not open the case");
    } finally {
      setBusy(false);
    }
  }

  async function setStatusOn(id: string, next: string, closureReason?: string) {
    setBusy(true);
    setDetailError(null);
    try {
      await api.patch(`/api/v1/integrity-cases/${id}`, {
        status: next,
        ...(closureReason ? { closureReason } : {}),
      });
      await load();
      const refreshed = await api.get<CaseDetail>(`/api/v1/integrity-cases/${id}`);
      setDetail(refreshed);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Could not update the case");
    } finally {
      setBusy(false);
    }
  }

  async function buildReferralPack(id: string) {
    setBusy(true);
    setDetailError(null);
    try {
      const res = await api.post<{ root: string; statement: string }>(
        `/api/v1/integrity-cases/${id}/referral-pack`,
        referTarget.trim() ? { referralTarget: referTarget.trim() } : {},
      );
      setPackResult(res);
      const refreshed = await api.get<CaseDetail>(`/api/v1/integrity-cases/${id}`);
      setDetail(refreshed);
      await load();
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Could not build the referral pack");
    } finally {
      setBusy(false);
    }
  }

  const openCount = (items ?? []).filter((c) => c.status === "open" || c.status === "investigating").length;
  const referred = (items ?? []).filter((c) => c.status === "referred").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Cases" value={items?.length ?? "—"} />
        <StatCard label="Open / investigating" value={items ? openCount : "—"} />
        <StatCard label="Referred" value={items ? referred : "—"} tone={referred > 0 ? "red" : "default"} />
        <StatCard
          label="Substantiated"
          value={items ? (items ?? []).filter((c) => c.status === "substantiated").length : "—"}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-52">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {INTEGRITY_CASE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Open a case</Button>
      </div>

      <ErrorAlert message={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No integrity cases"
          hint="Group related signals into a case when a finding needs to be worked rather than dismissed."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Reference</Th>
              <Th>Title</Th>
              <Th>Status</Th>
              <Th>Severity</Th>
              <Th>Opened</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <Td className="whitespace-nowrap font-mono text-xs">{c.reference}</Td>
                <Td>
                  <div className="text-sm font-medium text-ink-900">{c.title}</div>
                  {c.referralTarget ? (
                    <div className="text-[11px] text-ink-500">referred to {c.referralTarget}</div>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={statusTone(c.status)}>{humanize(c.status)}</Badge>
                </Td>
                <Td>
                  <Badge tone={severityTone(c.severity)}>{humanize(c.severity)}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-xs text-ink-500">
                  {formatDateTime(c.createdAt)}
                </Td>
                <Td className="whitespace-nowrap">
                  <Button size="sm" variant="secondary" onClick={() => void open(c)}>
                    Open
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Drawer open={detail !== null} onClose={() => setDetail(null)} title={detail?.reference ?? "Case"}>
        <ErrorAlert message={detailError} />
        {detail === null ? null : (
          <div className="space-y-4 p-4">
            <div>
              <div className="text-sm font-semibold text-ink-900">{detail.title}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Badge tone={statusTone(detail.status)}>{humanize(detail.status)}</Badge>
                <Badge tone={severityTone(detail.severity)}>{humanize(detail.severity)}</Badge>
                {detail.projectId ? (
                  <span className="font-mono text-[11px] text-ink-400">{detail.projectId}</span>
                ) : (
                  <span className="text-[11px] text-ink-400">tenant-level</span>
                )}
              </div>
              {detail.summary ? (
                <p className="mt-2 text-xs text-ink-600">{detail.summary}</p>
              ) : null}
              {detail.closureReason ? (
                <p className="mt-2 rounded bg-ink-50 px-2 py-1 text-xs text-ink-700">
                  Closed: {detail.closureReason}
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              {["investigating", "substantiated", "unsubstantiated"].map((next) => (
                <Button
                  key={next}
                  size="sm"
                  variant="secondary"
                  disabled={busy || detail.status === next}
                  onClick={() =>
                    void setStatusOn(
                      detail.id,
                      next,
                      next === "investigating"
                        ? undefined
                        : `Marked ${humanize(next).toLowerCase()} by the reviewer.`,
                    )
                  }
                >
                  {humanize(next)}
                </Button>
              ))}
            </div>

            <Card>
              <CardBody>
                <div className="text-sm font-semibold text-ink-900">
                  Signals on this case ({detail.signals.length})
                </div>
                {detail.signals.length === 0 ? (
                  <p className="mt-1 text-xs text-ink-500">
                    Nothing attached yet. A signal attached to a case is escalated by that act.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {detail.signals.map((s) => (
                      <li key={s.id} className="rounded border border-ink-100 p-2">
                        <div className="flex items-center gap-2">
                          <Badge tone={severityTone(s.severity)}>{humanize(s.severity)}</Badge>
                          <span className="text-xs font-medium text-ink-900">{s.title}</span>
                        </div>
                        <p className="mt-1 text-[11px] text-ink-500">{s.explanation}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardBody>
                <div className="text-sm font-semibold text-ink-900">Referral pack</div>
                <p className="mt-0.5 text-xs text-ink-500">
                  Merkle-commits every signal and evidence row on the case, records the ledger head
                  and seal in force, and states what was excluded and why.
                </p>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="w-64">
                    <Field label="Referral target (optional)">
                      <Input
                        value={referTarget}
                        onChange={(e) => setReferTarget(e.target.value)}
                        placeholder="Regulator, auditor, board committee…"
                      />
                    </Field>
                  </div>
                  <Button disabled={busy} onClick={() => void buildReferralPack(detail.id)}>
                    {busy ? "Building…" : "Build referral pack"}
                  </Button>
                </div>
                {packResult ? (
                  <div className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-900 ring-1 ring-emerald-200">
                    <div className="font-mono">root {truncateMiddle(packResult.root, 12)}</div>
                    <div className="mt-1">{packResult.statement}</div>
                  </div>
                ) : null}
                {detail.packs.length > 0 ? (
                  <ul className="mt-3 space-y-1 text-xs">
                    {detail.packs.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2">
                        <span>
                          {p.title} · {p.itemCount} item{p.itemCount === 1 ? "" : "s"} ·{" "}
                          {formatDateTime(p.generatedAt)}
                          {p.sealSequence !== null ? ` · seal #${p.sealSequence}` : " · unsealed"}
                        </span>
                        <button
                          type="button"
                          className="text-brand-700 underline"
                          onClick={() => {
                            void downloadAuthenticated(
                              `/api/v1/evidence-packs/${p.id}/download`,
                              `constructos-evidence-pack-${p.id}.json`,
                            ).catch((err: unknown) =>
                              setDetailError(
                                err instanceof Error ? err.message : "Download failed",
                              ),
                            );
                          }}
                        >
                          JSON
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardBody>
            </Card>
          </div>
        )}
      </Drawer>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Open an integrity case">
        <form onSubmit={onCreate} className="space-y-3 p-4">
          <ErrorAlert message={createError} />
          <Field label="Title">
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              required
            />
          </Field>
          <Field label="Summary">
            <Textarea
              rows={3}
              value={form.summary}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
            />
          </Field>
          <Field label="Severity">
            <Select
              value={form.severity}
              onChange={(e) => setForm({ ...form, severity: e.target.value })}
            >
              {SIGNAL_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || form.title.trim().length === 0}>
              {busy ? "Opening…" : "Open case"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
