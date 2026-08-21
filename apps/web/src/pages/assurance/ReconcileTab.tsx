/**
 * Reconcile tab — the assertion-vs-evidence workspace. Pick one assertion,
 * multi-select independent evidence, choose a method, create a
 * reconciliation, and read the verdicts below.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ASSERTION_KINDS, EVIDENCE_KINDS, RECONCILIATION_RESULTS } from "@constructos/shared";
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
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  HashChip,
  pct,
  reconResultTone,
  ScoreMeter,
  WarnBanner,
  type AssertionRow,
  type EvidenceRow,
  type ListResponse,
  type ReconciliationRow,
} from "./assuranceShared";

interface AssertionForm {
  kind: string;
  value: string;
  unit: string;
  basis: string;
  contractRef: string;
}

const emptyAssertion: AssertionForm = { kind: "quantity", value: "", unit: "", basis: "", contractRef: "" };

interface EvidenceForm {
  kind: string;
  source: string;
  independenceScore: string;
  value: string;
  metadata: string;
}

const emptyEvidence: EvidenceForm = {
  kind: "document",
  source: "",
  independenceScore: "0.5",
  value: "",
  metadata: "",
};

export default function ReconcileTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;

  const [assertions, setAssertions] = useState<AssertionRow[] | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRow[] | null>(null);
  const [recons, setRecons] = useState<ReconciliationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selAssertion, setSelAssertion] = useState<string | null>(null);
  const [selEvidence, setSelEvidence] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState("evidence_mean_vs_assertion");
  const [manualResult, setManualResult] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [sodWarning, setSodWarning] = useState<string | null>(null);

  const [assertOpen, setAssertOpen] = useState(false);
  const [assertForm, setAssertForm] = useState<AssertionForm>(emptyAssertion);
  const [assertError, setAssertError] = useState<string | null>(null);
  const [assertBusy, setAssertBusy] = useState(false);

  const [evdOpen, setEvdOpen] = useState(false);
  const [evdForm, setEvdForm] = useState<EvidenceForm>(emptyEvidence);
  const [evdFile, setEvdFile] = useState<File | null>(null);
  const [evdError, setEvdError] = useState<string | null>(null);
  const [evdBusy, setEvdBusy] = useState(false);

  const [dispBusyId, setDispBusyId] = useState<string | null>(null);
  const [dispDraft, setDispDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const [a, e, r] = await Promise.all([
        api.get<ListResponse<AssertionRow>>(`${base}/assertions?pageSize=100`),
        api.get<ListResponse<EvidenceRow>>(`${base}/evidence?pageSize=100`),
        api.get<ListResponse<ReconciliationRow>>(`${base}/reconciliations?pageSize=100`),
      ]);
      setAssertions(a.items);
      setEvidence(e.items);
      setRecons(r.items);
    } catch (err) {
      setAssertions([]);
      setEvidence([]);
      setRecons([]);
      setError(err instanceof Error ? err.message : "Failed to load reconciliation data");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreateReconciliation() {
    if (!selAssertion || selEvidence.size === 0) return;
    setCreateBusy(true);
    setCreateError(null);
    setSodWarning(null);
    try {
      const payload: Record<string, unknown> = {
        assertionId: selAssertion,
        evidenceIds: [...selEvidence],
        method: method.trim() || "manual",
      };
      if (method.trim() === "manual" && manualResult) payload["result"] = manualResult;
      await api.post(`${base}/reconciliations`, payload);
      setSelEvidence(new Set());
      await load();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) {
        setSodWarning(
          "Blocked by the separation rule: the selected evidence was all submitted by the assertion's claimant. Only an Integrity Reviewer may reconcile self-certified evidence.",
        );
      } else {
        setCreateError(err instanceof Error ? err.message : "Failed to create reconciliation");
      }
    } finally {
      setCreateBusy(false);
    }
  }

  async function onCreateAssertion(e: FormEvent) {
    e.preventDefault();
    setAssertBusy(true);
    setAssertError(null);
    try {
      const payload: Record<string, unknown> = {
        kind: assertForm.kind,
        basis: assertForm.basis.trim(),
      };
      if (assertForm.value.trim() !== "") payload["value"] = Number(assertForm.value);
      if (assertForm.unit.trim()) payload["unit"] = assertForm.unit.trim();
      if (assertForm.contractRef.trim()) payload["contractRef"] = assertForm.contractRef.trim();
      await api.post(`${base}/assertions`, payload);
      setAssertOpen(false);
      setAssertForm(emptyAssertion);
      await load();
    } catch (err) {
      setAssertError(err instanceof Error ? err.message : "Failed to create the assertion");
    } finally {
      setAssertBusy(false);
    }
  }

  async function onIngestEvidence(e: FormEvent) {
    e.preventDefault();
    setEvdBusy(true);
    setEvdError(null);
    try {
      let metadata: Record<string, unknown> = {};
      if (evdForm.metadata.trim()) {
        try {
          const parsed: unknown = JSON.parse(evdForm.metadata);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          } else throw new Error("not an object");
        } catch {
          throw new Error("Metadata must be a JSON object, e.g. {\"note\": \"delivery ticket\"}");
        }
      }
      if (evdForm.value.trim() !== "") {
        const n = Number(evdForm.value);
        if (!Number.isFinite(n)) throw new Error("Measured value must be a number");
        metadata["value"] = n;
      }
      if (evdFile) {
        const form = new FormData();
        form.append("kind", evdForm.kind);
        form.append("source", evdForm.source.trim());
        form.append("independenceScore", evdForm.independenceScore || "0");
        form.append("metadata", JSON.stringify(metadata));
        form.append("file", evdFile);
        await api.upload(`${base}/evidence`, form);
      } else {
        await api.post(`${base}/evidence`, {
          kind: evdForm.kind,
          source: evdForm.source.trim(),
          independenceScore: Number(evdForm.independenceScore || "0"),
          metadata,
        });
      }
      setEvdOpen(false);
      setEvdForm(emptyEvidence);
      setEvdFile(null);
      await load();
    } catch (err) {
      setEvdError(err instanceof Error ? err.message : "Failed to ingest evidence");
    } finally {
      setEvdBusy(false);
    }
  }

  async function setReconDisposition(id: string) {
    const disposition = dispDraft[id];
    if (!disposition || !disposition.trim()) return;
    setDispBusyId(id);
    setSodWarning(null);
    setCreateError(null);
    try {
      await api.patch(`/api/v1/reconciliations/${id}/disposition`, { disposition: disposition.trim() });
      await load();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) {
        setSodWarning(
          "Reconciliation disposition requires an Integrity Reviewer or Auditor grant — segregation of duties.",
        );
      } else {
        setCreateError(err instanceof Error ? err.message : "Failed to set disposition");
      }
    } finally {
      setDispBusyId(null);
    }
  }

  const assertionById = new Map((assertions ?? []).map((a) => [a.id, a]));
  const loading = assertions === null || evidence === null || recons === null;

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />
      <WarnBanner message={sodWarning} />
      <ErrorAlert message={createError} />

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            {/* Assertions */}
            <Card>
              <CardBody>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-semibold text-ink-900">1 · Assertion</div>
                  <Button size="sm" variant="secondary" onClick={() => setAssertOpen(true)}>
                    New assertion
                  </Button>
                </div>
                {assertions.length === 0 ? (
                  <EmptyState title="No assertions yet" hint="Record a claim to test against evidence." />
                ) : (
                  <div className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
                    {assertions.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => setSelAssertion(a.id)}
                        className={`block w-full rounded-md border px-3 py-2 text-left text-sm ${
                          selAssertion === a.id
                            ? "border-brand-500 bg-brand-50/60 ring-1 ring-brand-500"
                            : "border-ink-100 hover:bg-ink-50"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Badge tone="blue">{humanize(a.kind)}</Badge>
                          <span className="font-mono text-xs text-ink-700">
                            {a.value !== null ? `${a.value} ${a.unit ?? ""}`.trim() : "—"}
                          </span>
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs text-ink-600">{a.basis}</div>
                        {a.contractRef ? (
                          <div className="mt-0.5 text-xs text-ink-400">Ref: {a.contractRef}</div>
                        ) : null}
                      </button>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>

            {/* Evidence */}
            <Card>
              <CardBody>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-semibold text-ink-900">2 · Evidence</div>
                  <Button size="sm" variant="secondary" onClick={() => setEvdOpen(true)}>
                    Ingest evidence
                  </Button>
                </div>
                {evidence.length === 0 ? (
                  <EmptyState title="No evidence yet" hint="Ingest independent observations first." />
                ) : (
                  <div className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
                    {evidence.map((ev) => {
                      const checked = selEvidence.has(ev.id);
                      const numeric = ev.metadata?.["value"];
                      return (
                        <label
                          key={ev.id}
                          className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                            checked ? "border-brand-500 bg-brand-50/60" : "border-ink-100 hover:bg-ink-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={checked}
                            onChange={(e) => {
                              setSelEvidence((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(ev.id);
                                else next.delete(ev.id);
                                return next;
                              });
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <Badge tone="violet">{humanize(ev.kind)}</Badge>
                              {typeof numeric === "number" ? (
                                <span className="font-mono text-xs text-ink-700">{numeric}</span>
                              ) : null}
                            </span>
                            <span className="mt-1 block truncate text-xs text-ink-600">{ev.source}</span>
                            <span className="mt-1 block">
                              <ScoreMeter value={ev.independenceScore} />
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </CardBody>
            </Card>

            {/* Action */}
            <Card>
              <CardBody>
                <div className="mb-2 text-sm font-semibold text-ink-900">3 · Reconcile</div>
                <div className="space-y-3">
                  <div className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-600">
                    {selAssertion
                      ? `Assertion: ${humanize(assertionById.get(selAssertion)?.kind ?? "")} — ${
                          assertionById.get(selAssertion)?.basis ?? ""
                        }`.slice(0, 140)
                      : "Select one assertion."}
                    <br />
                    {selEvidence.size} evidence record{selEvidence.size === 1 ? "" : "s"} selected.
                  </div>
                  <Field label="Method" hint='Use "manual" to record a judgement call with an explicit result.'>
                    <Input value={method} onChange={(e) => setMethod(e.target.value)} />
                  </Field>
                  {method.trim() === "manual" ? (
                    <Field label="Manual result">
                      <Select value={manualResult} onChange={(e) => setManualResult(e.target.value)}>
                        <option value="">Choose…</option>
                        {RECONCILIATION_RESULTS.map((r) => (
                          <option key={r} value={r}>
                            {humanize(r)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : null}
                  <Button
                    className="w-full"
                    disabled={createBusy || !selAssertion || selEvidence.size === 0}
                    onClick={() => void onCreateReconciliation()}
                  >
                    {createBusy ? "Reconciling…" : "Create reconciliation"}
                  </Button>
                </div>
              </CardBody>
            </Card>
          </div>

          {/* Results */}
          <div>
            <div className="mb-2 text-sm font-semibold text-ink-900">Reconciliations</div>
            {recons.length === 0 ? (
              <EmptyState
                title="No reconciliations yet"
                hint="Every verdict is hash-chained to the ledger the moment it is created."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Result</Th>
                    <Th>Assertion</Th>
                    <Th>Method</Th>
                    <Th>Variance</Th>
                    <Th>Confidence</Th>
                    <Th>Disposition</Th>
                    <Th>Evidence</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {recons.map((r) => {
                    const a = assertionById.get(r.assertionId);
                    const vp = r.variancePercent;
                    return (
                      <tr key={r.id} className="hover:bg-ink-50/60">
                        <Td>
                          <Badge tone={reconResultTone(r.result)}>{humanize(r.result)}</Badge>
                        </Td>
                        <Td className="max-w-xs">
                          <span className="line-clamp-1 text-xs">
                            {a ? `${humanize(a.kind)} — ${a.basis}` : r.assertionId}
                          </span>
                        </Td>
                        <Td className="font-mono text-xs">{r.method}</Td>
                        <Td className="whitespace-nowrap tabular-nums">
                          {vp === null || vp === undefined ? (
                            "—"
                          ) : (
                            <span className={vp === 0 ? "text-ink-700" : vp > 0 ? "text-amber-600" : "text-red-600"}>
                              {vp > 0 ? "▲" : vp < 0 ? "▼" : "•"} {Math.abs(vp).toFixed(1)}%
                            </span>
                          )}
                        </Td>
                        <Td className="tabular-nums">{pct(r.confidence)}</Td>
                        <Td>
                          {r.disposition ? (
                            <Badge tone="gray">{humanize(r.disposition)}</Badge>
                          ) : (
                            <span className="flex items-center gap-1">
                              <input
                                className="w-24 rounded border border-ink-200 px-1.5 py-0.5 text-xs"
                                placeholder="disposition"
                                value={dispDraft[r.id] ?? ""}
                                onChange={(e) =>
                                  setDispDraft((d) => ({ ...d, [r.id]: e.target.value }))
                                }
                              />
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={dispBusyId === r.id || !(dispDraft[r.id] ?? "").trim()}
                                onClick={() => void setReconDisposition(r.id)}
                              >
                                Set
                              </Button>
                            </span>
                          )}
                        </Td>
                        <Td className="text-xs text-ink-500">{r.evidenceIds.length}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </div>
        </>
      )}

      {/* Create assertion modal */}
      <Modal open={assertOpen} title="New assertion" onClose={() => setAssertOpen(false)}>
        <ErrorAlert message={assertError} />
        <form onSubmit={onCreateAssertion} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Kind">
              <Select
                value={assertForm.kind}
                onChange={(e) => setAssertForm((f) => ({ ...f, kind: e.target.value }))}
              >
                {ASSERTION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Value">
              <Input
                type="number"
                step="any"
                value={assertForm.value}
                onChange={(e) => setAssertForm((f) => ({ ...f, value: e.target.value }))}
                placeholder="1250"
              />
            </Field>
            <Field label="Unit">
              <Input
                value={assertForm.unit}
                onChange={(e) => setAssertForm((f) => ({ ...f, unit: e.target.value }))}
                placeholder="m3"
              />
            </Field>
          </div>
          <Field label="Basis" hint="What is being claimed, and on what grounds?">
            <Textarea
              required
              value={assertForm.basis}
              onChange={(e) => setAssertForm((f) => ({ ...f, basis: e.target.value }))}
              placeholder="Concrete poured to level 3 slab per pour ticket summary"
            />
          </Field>
          <Field label="Contract reference">
            <Input
              value={assertForm.contractRef}
              onChange={(e) => setAssertForm((f) => ({ ...f, contractRef: e.target.value }))}
              placeholder="Clause 14.3 / BoQ item 2.1.4"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAssertOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={assertBusy}>
              {assertBusy ? "Creating…" : "Create assertion"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Ingest evidence modal */}
      <Modal open={evdOpen} title="Ingest evidence" onClose={() => setEvdOpen(false)}>
        <ErrorAlert message={evdError} />
        <form onSubmit={onIngestEvidence} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Kind">
              <Select
                value={evdForm.kind}
                onChange={(e) => setEvdForm((f) => ({ ...f, kind: e.target.value }))}
              >
                {EVIDENCE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Independence score" hint="0 = self-certified · 1 = fully independent">
              <Input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={evdForm.independenceScore}
                onChange={(e) => setEvdForm((f) => ({ ...f, independenceScore: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="Source" hint="Who or what captured this evidence.">
            <Input
              required
              value={evdForm.source}
              onChange={(e) => setEvdForm((f) => ({ ...f, source: e.target.value }))}
              placeholder="Weighbridge ticket, surveyor XYZ, telematics feed…"
            />
          </Field>
          <Field
            label="Measured value"
            hint="Numeric observation stored as metadata.value — this is what reconciliation compares against the assertion."
          >
            <Input
              type="number"
              step="any"
              className="ring-2 ring-brand-200"
              value={evdForm.value}
              onChange={(e) => setEvdForm((f) => ({ ...f, value: e.target.value }))}
              placeholder="1210"
            />
          </Field>
          <Field label="Additional metadata (JSON)">
            <Textarea
              value={evdForm.metadata}
              onChange={(e) => setEvdForm((f) => ({ ...f, metadata: e.target.value }))}
              placeholder='{"ticketNo": "WB-2231", "plate": "AB12 CDE"}'
              className="font-mono text-xs"
            />
          </Field>
          <Field label="File (optional)" hint="Attaching a file stores it and hashes its content.">
            <input
              type="file"
              className="block w-full text-sm text-ink-600 file:mr-3 file:rounded-md file:border-0 file:bg-ink-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink-700 hover:file:bg-ink-200"
              onChange={(e) => setEvdFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEvdOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={evdBusy}>
              {evdBusy ? "Ingesting…" : "Ingest evidence"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Small footnote about hashes */}
      {evidence && evidence.length > 0 ? (
        <p className="text-xs text-ink-400">
          Content hashes: {evidence.slice(0, 3).map((ev) => (
            <span key={ev.id} className="mr-3">
              <HashChip value={ev.contentHash} />
            </span>
          ))}
          — every record is chained into the company ledger.
        </p>
      ) : null}
    </div>
  );
}
