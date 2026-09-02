/**
 * CLOSEOUT AND FINAL RELEASE (#539).
 *
 * Every required item is satisfied by an EVIDENCE ID, not a tick. Two items
 * the platform verifies itself (the final unconditional waiver, no open
 * backcharge) cannot be un-ticked by hand. Final release schedules a payment
 * of exactly the remaining retainage — approve and issue still take two
 * other people.
 */
import { useState } from "react";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, Field, Input, Modal, Select, Textarea } from "../../ui";
import { RefusalPanel, money, titleCase, useAction, useResource, type Loadable } from "./shared";
import type { Commitment } from "./types";

interface CloseoutItem {
  key: string;
  label: string;
  required: boolean;
  done: boolean;
  evidenceType: string | null;
  evidenceId: string | null;
  note: string | null;
  completedBy: string | null;
  completedAt: string | null;
  autoVerified: boolean;
}

interface Closeout {
  commitmentId: string;
  status: string;
  items: CloseoutItem[];
  evaluation: { passes: boolean; outstanding: CloseoutItem[]; unevidenced: CloseoutItem[]; reasons: string[] };
  overrideReason: string | null;
  finalReleasePaymentId: string | null;
  remainingRetainage: number;
  currency: string;
}

export function useCloseout(commitmentId: string | null): Loadable<Closeout> {
  return useResource<Closeout>(commitmentId ? `/api/v1/commitments/${commitmentId}/closeout` : null);
}

export default function CloseoutPanel({ commitment, onChanged }: { commitment: Commitment; onChanged: () => void }) {
  const closeout = useCloseout(commitment.id);
  const { busy, refusal, clear, run } = useAction();
  const [editing, setEditing] = useState<CloseoutItem | null>(null);
  const [evidenceType, setEvidenceType] = useState("document");
  const [evidenceId, setEvidenceId] = useState("");
  const [note, setNote] = useState("");
  const [releasing, setReleasing] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [method, setMethod] = useState("check");

  const data = closeout.data;

  async function saveItem(done: boolean) {
    if (!editing) return;
    const body = {
      done,
      ...(evidenceId.trim() ? { evidenceType, evidenceId: evidenceId.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const ok = await run(`item:${editing.key}`, () => api.put(`/api/v1/commitments/${commitment.id}/closeout/items/${editing.key}`, body));
    if (ok !== null) {
      setEditing(null);
      setEvidenceId("");
      setNote("");
      closeout.reload();
      onChanged();
    }
  }

  async function finalRelease() {
    const body = { method, ...(overrideReason.trim() ? { overrideReason: overrideReason.trim() } : {}) };
    const ok = await run("final-release", () => api.post(`/api/v1/commitments/${commitment.id}/final-release`, body));
    if (ok !== null) {
      setReleasing(false);
      setOverrideReason("");
      closeout.reload();
      onChanged();
    }
  }

  return (
    <div className="space-y-3">
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      {closeout.error ? <Alert tone="danger">{closeout.error}</Alert> : null}
      {data ? (
        <>
          <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-label uppercase text-content-subtle">Checklist</p>
                <p className="flex items-center gap-2">
                  <Badge tone={data.evaluation.passes ? "success" : data.status === "overridden" ? "warning" : "neutral"}>
                    {data.evaluation.passes ? "passes" : titleCase(data.status)}
                  </Badge>
                  <span className="text-meta text-content-muted">
                    remaining retainage <span className="font-mono tabular-nums">{money(data.remainingRetainage, data.currency)}</span>
                  </span>
                </p>
                {data.overrideReason ? <p className="text-2xs text-warning-fg">Overridden: {data.overrideReason}</p> : null}
              </div>
              <div className="flex gap-2">
                {data.finalReleasePaymentId ? (
                  <Badge tone="info">final release scheduled</Badge>
                ) : (
                  <Button size="sm" onClick={() => setReleasing(true)} disabled={busy !== null || data.remainingRetainage <= 0.005}>
                    Schedule final release
                  </Button>
                )}
              </div>
            </CardBody>
          </Card>
          {!data.evaluation.passes && data.evaluation.reasons.length > 0 ? (
            <Alert tone="warning" size="sm" title="Why the checklist does not pass">
              <ul className="list-disc pl-4">
                {data.evaluation.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <div className="space-y-1">
            {data.items.map((item) => (
              <div key={item.key} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-meta">
                    <Badge tone={item.done ? "success" : item.required ? "warning" : "neutral"} size="xs">
                      {item.done ? "done" : item.required ? "required" : "optional"}
                    </Badge>
                    <span>{item.label}</span>
                    {item.autoVerified ? (
                      <Badge tone="info" variant="outline" size="xs">
                        verified by the platform
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-2xs text-content-subtle">
                    {item.evidenceId ? `${item.evidenceType ?? "evidence"} ${item.evidenceId}` : "no evidence recorded"}
                    {item.note ? ` · ${item.note}` : ""}
                    {item.completedAt ? ` · ${item.completedAt.slice(0, 10)}` : ""}
                  </p>
                </div>
                {!item.autoVerified ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => {
                      setEditing(item);
                      setEvidenceType(item.evidenceType ?? "document");
                      setEvidenceId(item.evidenceId ?? "");
                      setNote(item.note ?? "");
                    }}
                    disabled={busy !== null}
                  >
                    {item.done ? "Edit" : "Mark done"}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? editing.label : "Closeout item"}
        footer={
          <div className="flex justify-between gap-2">
            {editing?.done ? (
              <Button variant="ghost" onClick={() => void saveItem(false)}>
                Mark not done
              </Button>
            ) : (
              <span />
            )}
            <span className="flex gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button onClick={() => void saveItem(true)} disabled={!evidenceId.trim() || busy !== null}>
                Mark done with evidence
              </Button>
            </span>
          </div>
        }
      >
        <div className="space-y-3">
          <Alert tone="info" variant="subtle" size="sm">
            A tick with nothing behind it does not close a subcontract: name the document, waiver or record that satisfies this item.
          </Alert>
          <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
            <Field label="Evidence type">
              <Select value={evidenceType} onChange={(e) => setEvidenceType(e.target.value)}>
                {["document", "lien_waiver", "bond", "punch_list", "warranty", "other"].map((t) => (
                  <option key={t} value={t}>
                    {titleCase(t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Evidence id" required>
              <Input value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} />
            </Field>
          </div>
          <Field label="Note" optional>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={releasing}
        onClose={() => setReleasing(false)}
        title={`Final release on ${commitment.reference}`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReleasing(false)}>
              Cancel
            </Button>
            <Button onClick={() => void finalRelease()} disabled={busy !== null}>
              Schedule the release
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-meta">
            Schedules a payment of exactly the remaining retainage{" "}
            <span className="font-mono tabular-nums">{data ? money(data.remainingRetainage, data.currency) : "—"}</span>. It still needs approval and issue by two other people, and it is refused outright while a backcharge is open.
          </p>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {["check", "ach", "wire", "other"].map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </Select>
          </Field>
          {data && !data.evaluation.passes ? (
            <Field label="Override reason" hint="The checklist does not pass. Releasing anyway is recorded against the payment and the closeout.">
              <Textarea rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
            </Field>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
