/**
 * Redfern schedule — document production (spec Vol II Domain E #340-343).
 *
 * The table an international tribunal expects, rendered as the table:
 * what is requested, why it is relevant and material, the objection, and the
 * ruling. Each row is a record with a date, an author and a ledger entry, so
 * the schedule that goes to the tribunal is the same schedule the platform
 * holds — not a spreadsheet someone retyped.
 *
 * A grant needs a production date because a direction without a deadline is
 * not enforceable; the deadline lands on the obligation register with every
 * other dated commitment, and producing the documents satisfies it.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PRODUCTION_OBJECTION_GROUNDS } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from "../../ui";
import { formatDate, humanize } from "../format";
import type { DisputeDetail } from "./disputesShared";

interface ProductionRow {
  id: string;
  number: number;
  requestingParty: string;
  documentsRequested: string;
  relevance: string;
  objection: string | null;
  objectionGrounds: string[];
  reply: string | null;
  decision: string;
  decisionNote: string | null;
  decidedAt: string | null;
  productionDueDate: string | null;
  producedFileIds: string[];
  obligationId: string | null;
  createdAt: string;
}

interface ProductionResponse {
  items: ProductionRow[];
  summary: {
    total: number;
    pending: number;
    granted: number;
    grantedInPart: number;
    refused: number;
    withdrawn: number;
    objected: number;
    awaitingProduction: number;
  };
}

const DECISION_TONE: Record<string, string> = {
  pending: "gray",
  granted: "green",
  granted_in_part: "amber",
  refused: "red",
  withdrawn: "gray",
};

const ACTIVE_STATUSES = ["notified", "referred", "submissions", "hearing"];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ProductionTab({
  projectId,
  dispute,
  onChanged,
}: {
  projectId: string;
  dispute: DisputeDetail;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/disputes/${dispute.id}/production-requests`;
  const [data, setData] = useState<ProductionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const live = ACTIVE_STATUSES.includes(dispute.status);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<ProductionResponse>(base));
    } catch (err) {
      setData({
        items: [],
        summary: {
          total: 0,
          pending: 0,
          granted: 0,
          grantedInPart: 0,
          refused: 0,
          withdrawn: 0,
          objected: 0,
          awaitingProduction: 0,
        },
      });
      setError(
        err instanceof ApiClientError ? err.message : "Could not load the document production schedule",
      );
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    await load();
    onChanged();
  }

  /* --------------------------- new request modal --------------------------- */
  const [createOpen, setCreateOpen] = useState(false);
  const [party, setParty] = useState("claimant");
  const [documents, setDocuments] = useState("");
  const [relevance, setRelevance] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      await api.post(base, {
        requestingParty: party,
        documentsRequested: documents.trim(),
        relevance: relevance.trim(),
        productionDueDate: dueDate || null,
      });
      setCreateOpen(false);
      setDocuments("");
      setRelevance("");
      setDueDate("");
      await refresh();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Could not add the request.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------- objection / reply modal ------------------------ */
  const [editRow, setEditRow] = useState<ProductionRow | null>(null);
  const [objection, setObjection] = useState("");
  const [grounds, setGrounds] = useState<string[]>([]);
  const [reply, setReply] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  function openEdit(row: ProductionRow) {
    setEditRow(row);
    setObjection(row.objection ?? "");
    setGrounds(row.objectionGrounds ?? []);
    setReply(row.reply ?? "");
    setEditError(null);
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editRow) return;
    setEditError(null);
    setBusy(true);
    try {
      await api.patch(`${base}/${editRow.id}`, {
        objection: objection.trim() || null,
        objectionGrounds: grounds,
        reply: reply.trim() || null,
      });
      setEditRow(null);
      await refresh();
    } catch (err) {
      setEditError(err instanceof ApiClientError ? err.message : "Could not save the objection.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ ruling modal ------------------------------ */
  const [ruleRow, setRuleRow] = useState<ProductionRow | null>(null);
  const [decision, setDecision] = useState("granted");
  const [decisionNote, setDecisionNote] = useState("");
  const [ruleDue, setRuleDue] = useState("");
  const [ruleError, setRuleError] = useState<string | null>(null);

  function openRule(row: ProductionRow) {
    setRuleRow(row);
    setDecision("granted");
    setDecisionNote("");
    setRuleDue(row.productionDueDate ?? todayIso());
    setRuleError(null);
  }

  const grants = decision === "granted" || decision === "granted_in_part";

  async function onRule(e: FormEvent) {
    e.preventDefault();
    if (!ruleRow) return;
    setRuleError(null);
    setBusy(true);
    try {
      await api.post(`${base}/${ruleRow.id}/decide`, {
        decision,
        decisionNote: decisionNote.trim() || null,
        ...(grants ? { productionDueDate: ruleDue || null } : {}),
      });
      setRuleRow(null);
      await refresh();
    } catch (err) {
      setRuleError(err instanceof ApiClientError ? err.message : "Could not record the ruling.");
    } finally {
      setBusy(false);
    }
  }

  /* ---------------------------- production modal ---------------------------- */
  const [produceRow, setProduceRow] = useState<ProductionRow | null>(null);
  const [fileIds, setFileIds] = useState("");
  const [produceError, setProduceError] = useState<string | null>(null);

  async function onProduce(e: FormEvent) {
    e.preventDefault();
    if (!produceRow) return;
    const ids = fileIds
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      setProduceError("Name at least one file id.");
      return;
    }
    setProduceError(null);
    setBusy(true);
    try {
      await api.post(`${base}/${produceRow.id}/produce`, { fileIds: ids });
      setProduceRow(null);
      setFileIds("");
      await refresh();
    } catch (err) {
      setProduceError(
        err instanceof ApiClientError ? err.message : "Could not record the production.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (data === null) return <Spinner label="Loading the production schedule…" />;

  const s = data.summary;

  return (
    <div className="space-y-3">
      <ErrorAlert message={error} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Badge tone="gray">{s.total} requests</Badge>
          <Badge tone="blue">{s.pending} awaiting a ruling</Badge>
          <Badge tone="amber">{s.objected} objected to</Badge>
          <Badge tone={s.awaitingProduction > 0 ? "red" : "green"}>
            {s.awaitingProduction} awaiting production
          </Badge>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!live}>
          Add request
        </Button>
      </div>
      {!live ? (
        <p className="text-xs text-ink-400">
          This dispute is {humanize(dispute.status)}; document production belongs to a live
          reference, so no further requests can be filed.
        </p>
      ) : null}

      {data.items.length === 0 ? (
        <EmptyState
          title="No document production requests"
          description="A Redfern schedule records what each side has asked the other to produce, why it matters, the objection and the tribunal's ruling."
        />
      ) : (
        <div className="space-y-3">
          {data.items.map((r) => (
            <Card key={r.id}>
              <CardBody className="space-y-2 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-ink-400">
                      Request {String(r.number).padStart(2, "0")}
                    </span>
                    <Badge tone="gray">{humanize(r.requestingParty)}</Badge>
                    <Badge tone={DECISION_TONE[r.decision] ?? "gray"}>
                      {humanize(r.decision)}
                    </Badge>
                    {r.decidedAt ? (
                      <span className="text-xs text-ink-400">ruled {formatDate(r.decidedAt)}</span>
                    ) : null}
                  </div>
                  <div className="flex gap-1.5">
                    {r.decision === "pending" ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>
                          Objection / reply
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => openRule(r)}>
                          Record ruling
                        </Button>
                      </>
                    ) : null}
                    {(r.decision === "granted" || r.decision === "granted_in_part") &&
                    r.producedFileIds.length === 0 ? (
                      <Button size="sm" variant="secondary" onClick={() => setProduceRow(r)}>
                        Record production
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                      Documents requested
                    </div>
                    <p className="whitespace-pre-wrap text-ink-800">{r.documentsRequested}</p>
                  </div>
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                      Relevance and materiality
                    </div>
                    <p className="whitespace-pre-wrap text-ink-800">{r.relevance}</p>
                  </div>
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                      Objection
                    </div>
                    {r.objection ? (
                      <>
                        <p className="whitespace-pre-wrap text-ink-800">{r.objection}</p>
                        {r.objectionGrounds.length > 0 ? (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {r.objectionGrounds.map((g) => (
                              <Badge key={g} tone="amber" size="xs">
                                {humanize(g)}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                        {r.reply ? (
                          <p className="mt-1 whitespace-pre-wrap text-xs text-ink-600">
                            <span className="font-medium">Reply:</span> {r.reply}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-xs text-ink-400">None recorded</p>
                    )}
                  </div>
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                      Ruling
                    </div>
                    {r.decision === "pending" ? (
                      <p className="text-xs text-ink-400">Not yet ruled on</p>
                    ) : (
                      <>
                        <p className="text-ink-800">
                          {humanize(r.decision)}
                          {r.decisionNote ? ` — ${r.decisionNote}` : ""}
                        </p>
                        {r.productionDueDate ? (
                          <p className="mt-0.5 text-xs text-ink-500">
                            Production due {formatDate(r.productionDueDate)}
                            {r.obligationId ? " · on the obligation register" : ""}
                          </p>
                        ) : null}
                        {r.producedFileIds.length > 0 ? (
                          <p className="mt-0.5 text-xs text-emerald-700">
                            {r.producedFileIds.length} file
                            {r.producedFileIds.length === 1 ? "" : "s"} produced
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* new request */}
      <Modal
        open={createOpen}
        title="Document production request"
        onClose={() => setCreateOpen(false)}
        wide
      >
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Requesting party">
              <Select value={party} onChange={(e) => setParty(e.target.value)}>
                <option value="claimant">Claimant</option>
                <option value="respondent">Respondent</option>
              </Select>
            </Field>
            <Field label="Production date sought" hint="Optional until the request is granted">
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Documents requested">
            <Textarea
              required
              className="min-h-16"
              value={documents}
              onChange={(e) => setDocuments(e.target.value)}
              placeholder="All site diaries for weeks 20-32…"
            />
          </Field>
          <Field
            label="Relevance and materiality"
            hint="The case the tribunal will weigh against the objection"
          >
            <Textarea
              required
              className="min-h-16"
              value={relevance}
              onChange={(e) => setRelevance(e.target.value)}
              placeholder="Goes to the concurrency defence pleaded at paragraph 44…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Add to the schedule
            </Button>
          </div>
        </form>
      </Modal>

      {/* objection / reply */}
      <Modal
        open={editRow !== null}
        title={editRow ? `Request ${editRow.number} — objection and reply` : "Objection"}
        onClose={() => setEditRow(null)}
        wide
      >
        <ErrorAlert message={editError} />
        <form onSubmit={onSaveEdit} className="space-y-3">
          <Field label="Objection">
            <Textarea
              className="min-h-16"
              value={objection}
              onChange={(e) => setObjection(e.target.value)}
              placeholder="Disproportionate: thirteen weeks of diaries for a two-week window…"
            />
          </Field>
          <Field label="Grounds relied on">
            <div className="flex flex-wrap gap-2">
              {PRODUCTION_OBJECTION_GROUNDS.map((g) => (
                <label key={g} className="flex items-center gap-1 text-xs text-ink-700">
                  <input
                    type="checkbox"
                    checked={grounds.includes(g)}
                    onChange={(e) =>
                      setGrounds((prev) =>
                        e.target.checked ? [...prev, g] : prev.filter((x) => x !== g),
                      )
                    }
                  />
                  {humanize(g)}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Reply">
            <Textarea
              className="min-h-12"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Narrowed to weeks 24-26…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditRow(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </div>
        </form>
      </Modal>

      {/* ruling */}
      <Modal
        open={ruleRow !== null}
        title={ruleRow ? `Request ${ruleRow.number} — ruling` : "Ruling"}
        onClose={() => setRuleRow(null)}
      >
        <ErrorAlert message={ruleError} />
        <form onSubmit={onRule} className="space-y-3">
          <Field label="Decision">
            <Select value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="granted">Granted</option>
              <option value="granted_in_part">Granted in part</option>
              <option value="refused">Refused</option>
              <option value="withdrawn">Withdrawn</option>
            </Select>
          </Field>
          {grants ? (
            <Field
              label="Production due"
              hint="Required — a direction without a deadline is not enforceable"
            >
              <Input
                type="date"
                required
                value={ruleDue}
                onChange={(e) => setRuleDue(e.target.value)}
              />
            </Field>
          ) : null}
          <Field label="Note">
            <Textarea
              className="min-h-12"
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              placeholder="Limited to the shutdown weeks…"
            />
          </Field>
          <p className="text-xs text-ink-500">
            A ruling closes the row: the objection and reply can no longer be edited, and the
            request cannot be ruled on twice.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setRuleRow(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Record the ruling
            </Button>
          </div>
        </form>
      </Modal>

      {/* production */}
      <Modal
        open={produceRow !== null}
        title={produceRow ? `Request ${produceRow.number} — record production` : "Production"}
        onClose={() => setProduceRow(null)}
      >
        <ErrorAlert message={produceError} />
        <form onSubmit={onProduce} className="space-y-3">
          <Field
            label="File ids produced"
            hint="Space or comma separated; each must belong to this project"
          >
            <Textarea
              className="min-h-12"
              value={fileIds}
              onChange={(e) => setFileIds(e.target.value)}
            />
          </Field>
          <p className="text-xs text-ink-500">
            Recording production satisfies the obligation raised when the request was granted.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setProduceRow(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Record
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
