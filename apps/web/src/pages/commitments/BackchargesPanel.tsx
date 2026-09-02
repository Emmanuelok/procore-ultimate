/**
 * BACKCHARGES (#538) — cost recovered FROM the subcontractor.
 *
 * Issuing one raises a negative change order that somebody else approves;
 * until then the amount is RESERVED against the next payment. The evidence
 * list is mandatory at issue: recovering money on an assertion is a dispute.
 */
import { useState } from "react";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, EmptyState, Field, Input, Modal, Select, Textarea } from "../../ui";
import { RefusalPanel, isoDate, money, titleCase, useAction, useResource, type Loadable } from "./shared";
import type { Commitment } from "./types";

export interface Backcharge {
  id: string;
  reference: string;
  reasonCode: string;
  title: string;
  description: string | null;
  amount: number;
  currency: string;
  status: string;
  evidence: Array<{ type: string; id: string; label?: string }>;
  sovLineId: string | null;
  commitmentChangeId: string | null;
  issuedAt: string | null;
  disputeReason: string | null;
  settledAt: string | null;
  createdAt: string;
}

interface BackchargeList {
  items: Backcharge[];
  currency: string;
  register: { open: number; settled: number; disputed: number };
}

const REASONS = ["defective_work", "damage_to_others_work", "cleanup", "safety_violation", "schedule_delay", "supplied_materials", "equipment_use", "other"] as const;

function tone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  return status === "settled" ? "success" : status === "issued" ? "info" : status === "disputed" ? "warning" : status === "void" ? "danger" : "neutral";
}

export function useBackcharges(commitmentId: string | null): Loadable<BackchargeList> {
  return useResource<BackchargeList>(commitmentId ? `/api/v1/commitments/${commitmentId}/backcharges` : null);
}

export default function BackchargesPanel({ commitment, onChanged }: { commitment: Commitment; onChanged: () => void }) {
  const list = useBackcharges(commitment.id);
  const { busy, refusal, clear, run } = useAction();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState<string>("defective_work");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [evidenceType, setEvidenceType] = useState("punch_item");
  const [evidenceId, setEvidenceId] = useState("");
  const [evidenceLabel, setEvidenceLabel] = useState("");

  const rows = list.data?.items ?? [];
  const currency = list.data?.currency ?? commitment.currency;

  async function create() {
    const body = {
      reasonCode: reason,
      title: title.trim(),
      amount: Number(amount),
      ...(description.trim() ? { description: description.trim() } : {}),
      evidence: evidenceId.trim() ? [{ type: evidenceType, id: evidenceId.trim(), ...(evidenceLabel.trim() ? { label: evidenceLabel.trim() } : {}) }] : [],
    };
    const created = await run("create", () => api.post(`/api/v1/commitments/${commitment.id}/backcharges`, body));
    if (created !== null) {
      setCreating(false);
      setTitle("");
      setAmount("");
      setDescription("");
      setEvidenceId("");
      setEvidenceLabel("");
      list.reload();
      onChanged();
    }
  }

  async function act(row: Backcharge, path: string, body?: unknown) {
    const done = await run(`${path}:${row.id}`, () => api.post(`/api/v1/backcharges/${row.id}/${path}`, body ?? {}));
    if (done !== null) {
      list.reload();
      onChanged();
    }
  }

  const canRaise = commitment.status === "approved" || commitment.status === "complete";

  return (
    <div className="space-y-3">
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      {list.data ? (
        <Card>
          <CardBody className="grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-label uppercase text-content-subtle">Open (reserved against payment)</p>
              <p className="font-mono text-lg tabular-nums">{money(list.data.register.open, currency)}</p>
            </div>
            <div>
              <p className="text-label uppercase text-content-subtle">Disputed</p>
              <p className="font-mono text-lg tabular-nums">{money(list.data.register.disputed, currency)}</p>
            </div>
            <div>
              <p className="text-label uppercase text-content-subtle">Settled (inside the sum)</p>
              <p className="font-mono text-lg tabular-nums">{money(list.data.register.settled, currency)}</p>
            </div>
          </CardBody>
        </Card>
      ) : null}
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)} disabled={!canRaise}>
          Raise a backcharge
        </Button>
      </div>
      {!canRaise ? (
        <Alert tone="info" variant="subtle" size="sm">
          A backcharge is raised against an approved commitment; this one is {titleCase(commitment.status)}.
        </Alert>
      ) : null}
      {list.error ? <Alert tone="danger">{list.error}</Alert> : null}
      {rows.length === 0 && !list.loading ? (
        <EmptyState title="No backcharges" hint="Nothing has been recovered from this vendor. That is a fact on the record, not a gap." />
      ) : (
        <div className="space-y-2">
          {rows.map((b) => (
            <Card key={b.id}>
              <CardBody className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{b.reference}</span>
                    <span className="font-medium">{b.title}</span>
                    <Badge tone={tone(b.status)} size="xs">
                      {titleCase(b.status)}
                    </Badge>
                    <Badge tone="neutral" variant="outline" size="xs">
                      {titleCase(b.reasonCode)}
                    </Badge>
                  </div>
                  <p className="text-2xs text-content-subtle">
                    {money(b.amount, b.currency)} · raised {isoDate(b.createdAt)}
                    {b.issuedAt ? ` · issued ${isoDate(b.issuedAt)}` : ""}
                    {b.evidence.length > 0 ? ` · evidence: ${b.evidence.map((e) => e.label ?? `${e.type} ${e.id}`).join(", ")}` : " · no evidence attached"}
                    {b.disputeReason ? ` · disputed: ${b.disputeReason}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {b.status === "draft" ? (
                    <Button size="xs" onClick={() => void act(b, "issue")} disabled={busy !== null}>
                      Issue (raise negative CCO)
                    </Button>
                  ) : null}
                  {b.status === "issued" ? (
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => {
                        const r = window.prompt("The vendor's grounds for disputing this backcharge");
                        if (r && r.trim()) void act(b, "dispute", { reason: r.trim() });
                      }}
                      disabled={busy !== null}
                    >
                      Record dispute
                    </Button>
                  ) : null}
                  {b.status === "disputed" || b.status === "issued" ? (
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => {
                        const v = window.prompt(`Agreed amount (blank = ${b.amount})`, String(b.amount));
                        if (v === null) return;
                        void act(b, "settle", v.trim() ? { agreedAmount: Number(v) } : {});
                      }}
                      disabled={busy !== null}
                    >
                      Settle
                    </Button>
                  ) : null}
                  {b.status !== "settled" && b.status !== "void" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        const r = window.prompt(`Why is ${b.reference} voided?`);
                        if (r && r.trim()) void act(b, "void", { reason: r.trim() });
                      }}
                      disabled={busy !== null}
                    >
                      Void
                    </Button>
                  ) : null}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={`Raise a backcharge on ${commitment.reference}`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={!title.trim() || !(Number(amount) > 0) || busy !== null}>
              Create as draft
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Reason code">
              <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {titleCase(r)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Amount (${currency})`} required>
              <Input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
          <Field label="Description" optional>
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Evidence" hint="Required before issue: the punch item, NCR, incident or photo that proves it.">
            <div className="grid gap-2 sm:grid-cols-[140px_1fr_1fr]">
              <Select value={evidenceType} onChange={(e) => setEvidenceType(e.target.value)}>
                {["punch_item", "ncr", "incident", "photo", "document", "other"].map((t) => (
                  <option key={t} value={t}>
                    {titleCase(t)}
                  </option>
                ))}
              </Select>
              <Input value={evidenceId} placeholder="Record id" onChange={(e) => setEvidenceId(e.target.value)} />
              <Input value={evidenceLabel} placeholder="Label (optional)" onChange={(e) => setEvidenceLabel(e.target.value)} />
            </div>
          </Field>
        </div>
      </Modal>
    </div>
  );
}
