/**
 * Facility workspace — spec Vol II Domain O / M14: the conditions
 * precedent/subsequent checklist (#730-731), disbursement requests behind
 * the lender conditionality gate (#732-734), statement of expenditure
 * download (#735, #769), category utilisation (#739), undisbursed balance
 * and closing-date monitoring (#740-741), and covenant compliance with the
 * readings chart (#742-743).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { COVENANT_OPERATORS, FACILITY_CONDITION_KINDS } from "@constructos/shared";
import { api, ApiClientError, fetchBlobUrl } from "../../lib/api";
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
import { formatDate, formatDateTime, humanize } from "../format";
import CovenantChart from "./CovenantChart";
import EvidencePicker from "./EvidencePicker";
import {
  ClosingCountdown,
  conditionTone,
  daysUntil,
  DisbursedBar,
  disbursementTone,
  drLabel,
  DueCountdown,
  fmtMoney,
  fmtNum,
  instrumentTone,
  opGlyph,
  type ConditionRow,
  type CovenantReadingRow,
  type CovenantRow,
  type DisbursementRow,
  type FacilityDetailData,
  type OpenConditionLite,
} from "./financeShared";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function FacilityDetail({
  projectId,
  facilityId,
  onBack,
  onChanged,
}: {
  projectId: string;
  facilityId: string;
  onBack: () => void;
  /** notify the parent so the register + summary strip stay in sync */
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [detail, setDetail] = useState<FacilityDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const d = await api.get<FacilityDetailData>(`${base}/facilities/${facilityId}`);
      setDetail(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the facility");
    }
  }, [base, facilityId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reload() {
    await load();
    onChanged();
  }

  /* ------------------------- statement download (#735) ------------------------ */

  const [downloading, setDownloading] = useState(false);

  async function downloadStatement() {
    if (!detail) return;
    setDownloading(true);
    try {
      const url = await fetchBlobUrl(`${base}/facilities/${facilityId}/statement.csv`);
      const a = document.createElement("a");
      a.href = url;
      a.download = `statement-${detail.name.replace(/[^\w-]+/g, "-").toLowerCase()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Statement download failed");
    } finally {
      setDownloading(false);
    }
  }

  /* -------------------------- conditions (#730-731) --------------------------- */

  const [condOpen, setCondOpen] = useState(false);
  const [condError, setCondError] = useState<string | null>(null);
  const [condBusy, setCondBusy] = useState(false);
  const [cKind, setCKind] = useState<string>("precedent");
  const [cReference, setCReference] = useState("");
  const [cDescription, setCDescription] = useState("");
  const [cDueDate, setCDueDate] = useState("");

  function openCondModal(kind: string) {
    setCondError(null);
    setCKind(kind);
    setCReference("");
    setCDescription("");
    setCDueDate("");
    setCondOpen(true);
  }

  async function onCreateCondition(e: FormEvent) {
    e.preventDefault();
    setCondError(null);
    setCondBusy(true);
    try {
      const payload: Record<string, unknown> = { kind: cKind, description: cDescription.trim() };
      if (cReference.trim()) payload["reference"] = cReference.trim();
      if (cDueDate) payload["dueDate"] = cDueDate;
      await api.post(`${base}/facilities/${facilityId}/conditions`, payload);
      setCondOpen(false);
      await reload();
    } catch (err) {
      setCondError(err instanceof ApiClientError ? err.message : "Failed to add the condition.");
    } finally {
      setCondBusy(false);
    }
  }

  const [satisfyFor, setSatisfyFor] = useState<ConditionRow | null>(null);
  const [satisfyEvidence, setSatisfyEvidence] = useState<string[]>([]);
  const [satisfyError, setSatisfyError] = useState<string | null>(null);
  const [satisfyBusy, setSatisfyBusy] = useState(false);

  function openSatisfy(cond: ConditionRow) {
    setSatisfyError(null);
    setSatisfyEvidence([]);
    setSatisfyFor(cond);
  }

  async function onSatisfy(e: FormEvent) {
    e.preventDefault();
    if (!satisfyFor) return;
    setSatisfyError(null);
    setSatisfyBusy(true);
    try {
      await api.post(`${base}/facility-conditions/${satisfyFor.id}/satisfy`, {
        evidenceIds: satisfyEvidence,
      });
      setSatisfyFor(null);
      await reload();
    } catch (err) {
      setSatisfyError(
        err instanceof ApiClientError ? err.message : "Failed to satisfy the condition.",
      );
    } finally {
      setSatisfyBusy(false);
    }
  }

  const [waiveFor, setWaiveFor] = useState<ConditionRow | null>(null);
  const [waiveReason, setWaiveReason] = useState("");
  const [waiveError, setWaiveError] = useState<string | null>(null);
  const [waiveBusy, setWaiveBusy] = useState(false);

  async function onWaive(e: FormEvent) {
    e.preventDefault();
    if (!waiveFor) return;
    setWaiveError(null);
    setWaiveBusy(true);
    try {
      await api.post(`${base}/facility-conditions/${waiveFor.id}/waive`, {
        reason: waiveReason.trim(),
      });
      setWaiveFor(null);
      await reload();
    } catch (err) {
      setWaiveError(
        err instanceof ApiClientError
          ? err.status === 403
            ? `Waiving a lender condition requires finance admin rights. ${err.message}`
            : err.message
          : "Failed to waive the condition.",
      );
    } finally {
      setWaiveBusy(false);
    }
  }

  /** brief highlight after jumping from the conditionality gate panel */
  const [highlightId, setHighlightId] = useState<string | null>(null);

  function jumpToCondition(id: string) {
    document.getElementById(`cond-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(id);
    window.setTimeout(() => setHighlightId((h) => (h === id ? null : h)), 2500);
  }

  /* ------------------------- disbursements (#732-734) -------------------------- */

  const [requestOpen, setRequestOpen] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestBusy, setRequestBusy] = useState(false);
  const [rAmount, setRAmount] = useState("");
  const [rCategoryId, setRCategoryId] = useState("");
  const [rPurpose, setRPurpose] = useState("");
  const [rEvidence, setREvidence] = useState<string[]>([]);

  function openRequest() {
    setRequestError(null);
    setRAmount("");
    setRCategoryId("");
    setRPurpose("");
    setREvidence([]);
    setRequestOpen(true);
  }

  async function onCreateRequest(e: FormEvent) {
    e.preventDefault();
    setRequestError(null);
    setRequestBusy(true);
    try {
      const payload: Record<string, unknown> = {
        amount: Number(rAmount),
        purpose: rPurpose.trim(),
      };
      if (rCategoryId) payload["categoryId"] = rCategoryId;
      if (rEvidence.length > 0) payload["evidenceIds"] = rEvidence;
      await api.post(`${base}/facilities/${facilityId}/disbursements`, payload);
      setRequestOpen(false);
      await reload();
    } catch (err) {
      setRequestError(
        err instanceof ApiClientError ? err.message : "Failed to create the request.",
      );
    } finally {
      setRequestBusy(false);
    }
  }

  /** The conditionality gate result (#733): the 409 body's blocking list. */
  const [gate, setGate] = useState<{
    disbursement: DisbursementRow;
    message: string;
    openConditions: OpenConditionLite[];
  } | null>(null);
  /** Separation-of-duties / permission refusal banner (403). */
  const [sodMessage, setSodMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function runAction(d: DisbursementRow, verb: string, body?: unknown) {
    setActionError(null);
    setSodMessage(null);
    setBusyId(d.id);
    try {
      await api.post(`${base}/disbursements/${d.id}/${verb}`, body);
      if (gate?.disbursement.id === d.id) setGate(null);
      await reload();
      return true;
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (verb === "submit" && err.status === 409) {
          const details = err.details as { openConditions?: OpenConditionLite[] } | undefined;
          if (details?.openConditions && details.openConditions.length > 0) {
            setGate({ disbursement: d, message: err.message, openConditions: details.openConditions });
            await load(); // pick up the persisted verification snapshot
            return false;
          }
        }
        if (err.status === 403) {
          setSodMessage(err.message);
          return false;
        }
        setActionError(err.message);
      } else {
        setActionError("The action failed.");
      }
      return false;
    } finally {
      setBusyId(null);
    }
  }

  const [rejectFor, setRejectFor] = useState<DisbursementRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [rejectBusy, setRejectBusy] = useState(false);

  async function onReject(e: FormEvent) {
    e.preventDefault();
    if (!rejectFor) return;
    setRejectError(null);
    setRejectBusy(true);
    try {
      await api.post(`${base}/disbursements/${rejectFor.id}/reject`, {
        reason: rejectReason.trim(),
      });
      setRejectFor(null);
      await reload();
    } catch (err) {
      setRejectError(
        err instanceof ApiClientError
          ? err.status === 403
            ? `Rejecting a request requires finance admin rights. ${err.message}`
            : err.message
          : "Failed to reject the request.",
      );
    } finally {
      setRejectBusy(false);
    }
  }

  /* ---------------------------- covenants (#742-743) --------------------------- */

  const [covOpen, setCovOpen] = useState(false);
  const [covError, setCovError] = useState<string | null>(null);
  const [covBusy, setCovBusy] = useState(false);
  const [vName, setVName] = useState("");
  const [vDescription, setVDescription] = useState("");
  const [vOperator, setVOperator] = useState<string>("gte");
  const [vThreshold, setVThreshold] = useState("");
  const [vUnit, setVUnit] = useState("");

  function openCovModal() {
    setCovError(null);
    setVName("");
    setVDescription("");
    setVOperator("gte");
    setVThreshold("");
    setVUnit("");
    setCovOpen(true);
  }

  async function onCreateCovenant(e: FormEvent) {
    e.preventDefault();
    setCovError(null);
    setCovBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: vName.trim(),
        operator: vOperator,
        threshold: Number(vThreshold),
      };
      if (vDescription.trim()) payload["description"] = vDescription.trim();
      if (vUnit.trim()) payload["unit"] = vUnit.trim();
      await api.post(`${base}/facilities/${facilityId}/covenants`, payload);
      setCovOpen(false);
      await reload();
    } catch (err) {
      setCovError(err instanceof ApiClientError ? err.message : "Failed to add the covenant.");
    } finally {
      setCovBusy(false);
    }
  }

  /* ---------------------------------- render ---------------------------------- */

  if (error && !detail) {
    return (
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back to facilities
        </Button>
        <div className="mt-3">
          <ErrorAlert message={error} />
        </div>
      </div>
    );
  }
  if (!detail) return <Spinner label="Loading facility…" />;

  const currency = detail.currency;
  const conditions = detail.conditions;
  const precedent = conditions.filter((c) => c.kind === "precedent");
  const subsequent = conditions.filter((c) => c.kind === "subsequent");
  const catName = new Map(detail.categories.map((c) => [c.id, c.name]));

  function conditionSection(title: string, hint: string, rows: ConditionRow[], kind: string) {
    return (
      <Card>
        <CardBody>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
              <p className="text-xs text-ink-400">{hint}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => openCondModal(kind)}>
              Add condition
            </Button>
          </div>
          {rows.length === 0 ? (
            <p className="py-3 text-center text-xs text-ink-400">
              No conditions {kind} recorded.
            </p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {rows.map((c) => {
                const outstanding = c.status === "open" || c.status === "breached";
                return (
                  <li
                    key={c.id}
                    id={`cond-${c.id}`}
                    className={`flex flex-wrap items-start gap-3 py-2.5 transition-colors ${
                      highlightId === c.id ? "rounded-md bg-amber-50 ring-2 ring-amber-300" : ""
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {c.reference ? (
                          <span className="font-mono text-xs font-semibold text-ink-500">
                            {c.reference}
                          </span>
                        ) : null}
                        <Badge tone={conditionTone(c.status)}>{humanize(c.status)}</Badge>
                        {outstanding && c.dueDate ? (
                          <DueCountdown days={daysUntil(c.dueDate)} />
                        ) : null}
                        {c.status === "satisfied" ? (
                          <span className="text-[11px] text-ink-400">
                            {c.evidenceIds.length} evidence item
                            {c.evidenceIds.length === 1 ? "" : "s"} · {formatDate(c.satisfiedAt)}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-sm text-ink-800">{c.description}</p>
                      {c.dueDate ? (
                        <p className="mt-0.5 text-[11px] text-ink-400">
                          Due {formatDate(c.dueDate)}
                        </p>
                      ) : null}
                    </div>
                    {outstanding ? (
                      <div className="flex shrink-0 gap-1.5">
                        <Button size="sm" onClick={() => openSatisfy(c)}>
                          Satisfy
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          title="Admin — records a lender waiver with a reason"
                          onClick={() => {
                            setWaiveError(null);
                            setWaiveReason("");
                            setWaiveFor(c);
                          }}
                        >
                          Waive
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    );
  }

  return (
    <div>
      {/* ---------------------------------- header --------------------------------- */}
      <div className="mb-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back to facilities
        </Button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-ink-900">{detail.name}</h2>
              <Badge tone={instrumentTone(detail.instrument)}>{humanize(detail.instrument)}</Badge>
              <ClosingCountdown days={detail.daysToClosing} />
            </div>
            <p className="mt-0.5 text-sm text-ink-500">
              {detail.lender}
              {detail.availabilityEndDate
                ? ` · availability ends ${formatDate(detail.availabilityEndDate)}`
                : ""}
            </p>
          </div>
          <Button variant="secondary" onClick={() => void downloadStatement()} disabled={downloading}>
            {downloading ? "Preparing…" : "Download statement (CSV)"}
          </Button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card>
            <CardBody className="px-4 py-3">
              <div className="text-lg font-bold tabular-nums text-ink-900">
                {fmtMoney(detail.committedAmount, currency)}
              </div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Committed
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="px-4 py-3">
              <div className="text-lg font-bold tabular-nums text-ink-900">
                {fmtMoney(detail.disbursed, currency)}
              </div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Disbursed
              </div>
              <DisbursedBar
                committed={detail.committedAmount}
                disbursed={detail.disbursed}
                className="mt-2"
              />
            </CardBody>
          </Card>
          <Card>
            <CardBody className="px-4 py-3">
              <div className="text-lg font-bold tabular-nums text-brand-700">
                {fmtMoney(detail.undisbursed, currency)}
              </div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Undisbursed
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="px-4 py-3">
              <div
                className={`text-lg font-bold tabular-nums ${
                  detail.openConditions > 0 ? "text-amber-700" : "text-ink-900"
                }`}
              >
                {detail.openConditions}
              </div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Open conditions
              </div>
            </CardBody>
          </Card>
        </div>
      </div>

      <ErrorAlert message={error} />

      {/* ---------------------- conditions checklist (#730-731) --------------------- */}
      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {conditionSection(
          "Conditions precedent",
          "Must be satisfied before any disbursement request can be submitted (#733).",
          precedent,
          "precedent",
        )}
        {conditionSection(
          "Conditions subsequent",
          "Post-closing undertakings — an overdue one is an event-of-default risk.",
          subsequent,
          "subsequent",
        )}
      </div>

      {/* ------------------------- disbursements (#732-734) ------------------------- */}
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-900">Disbursement requests</h3>
        <Button size="sm" onClick={openRequest}>
          Request drawdown
        </Button>
      </div>

      {sodMessage ? (
        <div className="mb-3 rounded-md border-l-4 border-l-red-600 bg-red-50 px-3 py-2.5 text-sm text-red-800 ring-1 ring-red-100">
          <div className="font-semibold">Approval refused (403)</div>
          <p className="mt-0.5 text-xs leading-5">{sodMessage}</p>
        </div>
      ) : null}
      <ErrorAlert message={actionError} />

      {gate ? (
        <div className="mb-3 rounded-md border-l-4 border-l-red-600 bg-red-50 px-3 py-3 ring-1 ring-red-100">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-red-800">
                Blocked by open conditions precedent —{" "}
                {drLabel(gate.disbursement.number)} cannot be submitted
              </div>
              <p className="mt-0.5 text-xs leading-5 text-red-700">{gate.message}</p>
            </div>
            <button
              type="button"
              className="rounded p-1 text-red-400 hover:bg-red-100 hover:text-red-700"
              aria-label="Dismiss"
              onClick={() => setGate(null)}
            >
              ✕
            </button>
          </div>
          <ul className="mt-2 space-y-1.5">
            {gate.openConditions.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 text-xs text-red-900">
                <Badge tone={conditionTone(c.status)}>{humanize(c.status)}</Badge>
                {c.reference ? <span className="font-mono font-semibold">{c.reference}</span> : null}
                <span className="min-w-0 flex-1">{c.description}</span>
                {c.dueDate ? <span className="text-red-500">due {formatDate(c.dueDate)}</span> : null}
                <button
                  type="button"
                  className="font-semibold text-red-700 underline decoration-red-300 underline-offset-2 hover:text-red-900"
                  onClick={() => jumpToCondition(c.id)}
                >
                  View in checklist
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {detail.disbursements.length === 0 ? (
        <div className="mb-5">
          <EmptyState
            title="No disbursement requests yet"
            hint="Assemble a drawdown request with expenditure evidence — submission is gated on every condition precedent being satisfied or waived."
            action={<Button onClick={openRequest}>Request the first drawdown</Button>}
          />
        </div>
      ) : (
        <div className="mb-5">
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th className="text-right">Amount</Th>
                <Th>Category</Th>
                <Th>Purpose</Th>
                <Th>Status</Th>
                <Th>Dates</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {detail.disbursements.map((d) => (
                <tr key={d.id} className={gate?.disbursement.id === d.id ? "bg-red-50/50" : ""}>
                  <Td className="whitespace-nowrap font-mono text-xs text-ink-500">
                    {drLabel(d.number)}
                  </Td>
                  <Td className="whitespace-nowrap text-right font-medium tabular-nums">
                    {fmtMoney(d.amount, currency)}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">
                    {d.categoryId ? (catName.get(d.categoryId) ?? "—") : "—"}
                  </Td>
                  <Td>
                    <span className="line-clamp-2 max-w-xs text-xs">{d.purpose}</span>
                    {d.status === "rejected" && d.rejectionReason ? (
                      <span className="mt-0.5 block text-[11px] text-red-600">
                        Rejected: {d.rejectionReason}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={disbursementTone(d.status)}>{humanize(d.status)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-[11px] leading-4 text-ink-500">
                    {d.submittedAt ? <div>sub {formatDateTime(d.submittedAt)}</div> : null}
                    {d.approvedAt ? <div>app {formatDateTime(d.approvedAt)}</div> : null}
                    {d.disbursedAt ? (
                      <div className="font-medium text-emerald-700">
                        paid {formatDateTime(d.disbursedAt)}
                      </div>
                    ) : null}
                    {!d.submittedAt && !d.approvedAt && !d.disbursedAt ? (
                      <div>drafted {formatDate(d.createdAt)}</div>
                    ) : null}
                  </Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1.5">
                      {d.status === "draft" ? (
                        <Button
                          size="sm"
                          disabled={busyId === d.id}
                          title="Runs the lender conditionality verification (#733)"
                          onClick={() => void runAction(d, "submit")}
                        >
                          {busyId === d.id ? "Verifying…" : "Submit"}
                        </Button>
                      ) : null}
                      {d.status === "submitted" ? (
                        <Button
                          size="sm"
                          disabled={busyId === d.id}
                          title="Admin — separation of duties: the requester cannot approve"
                          onClick={() => void runAction(d, "approve")}
                        >
                          Approve
                        </Button>
                      ) : null}
                      {d.status === "approved" ? (
                        <Button
                          size="sm"
                          disabled={busyId === d.id}
                          onClick={() => void runAction(d, "disburse")}
                        >
                          Disburse
                        </Button>
                      ) : null}
                      {d.status === "submitted" || d.status === "approved" ? (
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={busyId === d.id}
                          onClick={() => {
                            setRejectError(null);
                            setRejectReason("");
                            setRejectFor(d);
                          }}
                        >
                          Reject
                        </Button>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      {/* ------------------------ category utilisation (#739) ----------------------- */}
      {detail.categories.length > 0 ? (
        <Card className="mb-5">
          <CardBody>
            <h3 className="mb-3 text-sm font-semibold text-ink-900">
              Category utilisation
              <span className="ml-2 text-xs font-normal text-ink-400">
                allocation limits vs disbursed (#739)
              </span>
            </h3>
            <div className="space-y-3">
              {detail.categories.map((c) => {
                const frac = c.limit > 0 ? Math.min(1, Math.max(0, c.disbursed / c.limit)) : 0;
                const exhausted = c.remaining <= 0;
                return (
                  <div key={c.id}>
                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-xs">
                      <span className="font-medium text-ink-800">{c.name}</span>
                      <span className="tabular-nums text-ink-500">
                        {fmtMoney(c.disbursed, currency)} of {fmtMoney(c.limit, currency)} ·{" "}
                        <span className={exhausted ? "font-semibold text-red-700" : "text-ink-600"}>
                          {fmtMoney(c.remaining, currency)} remaining
                        </span>
                      </span>
                    </div>
                    <div
                      className="h-2.5 w-full overflow-hidden rounded-full bg-ink-100"
                      title={`${c.name}: ${Math.round(frac * 100)}% of the ${fmtMoney(c.limit, currency)} allocation disbursed`}
                    >
                      <div
                        className={`h-full rounded-full ${exhausted ? "bg-red-600" : "bg-brand-600"}`}
                        style={{ width: `${frac * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* ---------------------------- covenants (#742-743) --------------------------- */}
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-900">Covenants</h3>
        <Button variant="secondary" size="sm" onClick={openCovModal}>
          Add covenant
        </Button>
      </div>
      {detail.covenants.length === 0 ? (
        <EmptyState
          title="No covenants defined"
          hint="Define the facility's financial covenants — each reading is tested against the threshold and a breach raises a critical signal."
          action={
            <Button variant="secondary" onClick={openCovModal}>
              Define the first covenant
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {detail.covenants.map((c) => (
            <CovenantCard
              key={c.id}
              base={base}
              covenant={c}
              onChanged={() => void reload()}
            />
          ))}
        </div>
      )}

      {/* ------------------------------- modals -------------------------------- */}

      <Modal
        open={condOpen}
        title={`Add condition ${cKind}`}
        onClose={() => setCondOpen(false)}
      >
        <ErrorAlert message={condError} />
        <form onSubmit={onCreateCondition} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Kind">
              <Select value={cKind} onChange={(e) => setCKind(e.target.value)}>
                {FACILITY_CONDITION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference" hint="Clause or schedule reference, e.g. CP 4.1(a).">
              <Input value={cReference} onChange={(e) => setCReference(e.target.value)} />
            </Field>
          </div>
          <Field label="Description">
            <Textarea
              required
              value={cDescription}
              onChange={(e) => setCDescription(e.target.value)}
              placeholder="Certified copy of the building permit delivered to the lender…"
            />
          </Field>
          <Field label="Due date" hint="Optional — an overdue open condition flips to breached.">
            <Input type="date" value={cDueDate} onChange={(e) => setCDueDate(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCondOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={condBusy}>
              {condBusy ? "Adding…" : "Add condition"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={satisfyFor !== null}
        title="Satisfy condition"
        onClose={() => setSatisfyFor(null)}
        wide
      >
        <ErrorAlert message={satisfyError} />
        {satisfyFor ? (
          <form onSubmit={onSatisfy} className="space-y-4">
            <div className="rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-700 ring-1 ring-ink-100">
              {satisfyFor.reference ? (
                <span className="mr-1.5 font-mono text-xs font-semibold text-ink-500">
                  {satisfyFor.reference}
                </span>
              ) : null}
              {satisfyFor.description}
            </div>
            <Field
              label="Substantiating evidence"
              hint="A condition is satisfied with evidence — select at least one record."
            >
              <EvidencePicker
                projectId={projectId}
                selected={satisfyEvidence}
                onChange={setSatisfyEvidence}
                requiredNote="at least one evidence record is required"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setSatisfyFor(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={satisfyBusy || satisfyEvidence.length === 0}>
                {satisfyBusy ? "Recording…" : "Mark satisfied"}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal open={waiveFor !== null} title="Waive condition" onClose={() => setWaiveFor(null)}>
        <ErrorAlert message={waiveError} />
        {waiveFor ? (
          <form onSubmit={onWaive} className="space-y-4">
            <div className="rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-700 ring-1 ring-ink-100">
              {waiveFor.reference ? (
                <span className="mr-1.5 font-mono text-xs font-semibold text-ink-500">
                  {waiveFor.reference}
                </span>
              ) : null}
              {waiveFor.description}
            </div>
            <Field
              label="Waiver reason"
              hint="Admin action — records the lender's waiver on the audit ledger."
            >
              <Textarea
                required
                value={waiveReason}
                onChange={(e) => setWaiveReason(e.target.value)}
                placeholder="Lender letter of 12 Aug waives CP 4.1(a) for the first drawdown…"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setWaiveFor(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" disabled={waiveBusy}>
                {waiveBusy ? "Waiving…" : "Waive condition"}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal open={requestOpen} title="Request drawdown" onClose={() => setRequestOpen(false)} wide>
        <ErrorAlert message={requestError} />
        <form onSubmit={onCreateRequest} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={`Amount (${currency})`}>
              <Input
                type="number"
                min="0.01"
                step="any"
                required
                value={rAmount}
                onChange={(e) => setRAmount(e.target.value)}
              />
            </Field>
            <Field label="Category" hint="Optional — draws against the category's allocation limit.">
              <Select value={rCategoryId} onChange={(e) => setRCategoryId(e.target.value)}>
                <option value="">Uncategorised</option>
                {detail.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {fmtNum(c.remaining)} remaining
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Purpose">
            <Textarea
              required
              value={rPurpose}
              onChange={(e) => setRPurpose(e.target.value)}
              className="min-h-16"
              placeholder="Interim payment certificate no. 7 — civil works package…"
            />
          </Field>
          <Field
            label="Expenditure evidence"
            hint="Optional at draft — assemble the supporting records for the withdrawal application."
          >
            <EvidencePicker projectId={projectId} selected={rEvidence} onChange={setREvidence} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRequestOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={requestBusy}>
              {requestBusy ? "Creating…" : "Create draft request"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={rejectFor !== null}
        title={rejectFor ? `Reject ${drLabel(rejectFor.number)}` : "Reject request"}
        onClose={() => setRejectFor(null)}
      >
        <ErrorAlert message={rejectError} />
        <form onSubmit={onReject} className="space-y-4">
          <Field label="Rejection reason">
            <Textarea
              required
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Evidence does not substantiate the claimed expenditure…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRejectFor(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={rejectBusy}>
              {rejectBusy ? "Rejecting…" : "Reject request"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={covOpen} title="Add covenant" onClose={() => setCovOpen(false)}>
        <ErrorAlert message={covError} />
        <form onSubmit={onCreateCovenant} className="space-y-4">
          <Field label="Name">
            <Input
              required
              value={vName}
              onChange={(e) => setVName(e.target.value)}
              placeholder="Debt service cover ratio"
            />
          </Field>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Test">
              <Select value={vOperator} onChange={(e) => setVOperator(e.target.value)}>
                {COVENANT_OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {op === "gte" ? "≥ at least" : "≤ at most"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Threshold">
              <Input
                type="number"
                step="any"
                required
                value={vThreshold}
                onChange={(e) => setVThreshold(e.target.value)}
              />
            </Field>
            <Field label="Unit" hint="e.g. ×, %, months">
              <Input value={vUnit} onChange={(e) => setVUnit(e.target.value)} />
            </Field>
          </div>
          <Field label="Description">
            <Textarea
              value={vDescription}
              onChange={(e) => setVDescription(e.target.value)}
              className="min-h-12"
              placeholder="Clause 18.2 — tested quarterly on a rolling 12-month basis…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCovOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={covBusy}>
              {covBusy ? "Adding…" : "Add covenant"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ------------------------------ covenant card ------------------------------ */

function CovenantCard({
  base,
  covenant,
  onChanged,
}: {
  base: string;
  covenant: CovenantRow;
  onChanged: () => void;
}) {
  const [readings, setReadings] = useState<CovenantReadingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadReadings = useCallback(async () => {
    try {
      const res = await api.get<{ items: CovenantReadingRow[] }>(
        `${base}/covenants/${covenant.id}/readings`,
      );
      setReadings(res.items);
    } catch (err) {
      setReadings([]);
      setError(err instanceof Error ? err.message : "Failed to load readings");
    }
  }, [base, covenant.id]);

  useEffect(() => {
    void loadReadings();
  }, [loadReadings]);

  const [rDate, setRDate] = useState(todayIso());
  const [rValue, setRValue] = useState("");
  const [rNote, setRNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function onAddReading(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { readingDate: rDate, value: Number(rValue) };
      if (rNote.trim()) payload["note"] = rNote.trim();
      await api.post(`${base}/covenants/${covenant.id}/readings`, payload);
      setRValue("");
      setRNote("");
      await loadReadings();
      onChanged();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Failed to record the reading.");
    } finally {
      setBusy(false);
    }
  }

  const latest = covenant.latestReading;
  const breach = covenant.compliant === false;
  const unit = covenant.unit ? ` ${covenant.unit}` : "";

  return (
    <Card className={breach ? "ring-2 ring-red-200" : ""}>
      <CardBody>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-ink-900">{covenant.name}</h4>
              {covenant.compliant === null ? (
                <Badge tone="gray">no readings</Badge>
              ) : breach ? (
                <Badge tone="red">✗ breach</Badge>
              ) : (
                <Badge tone="green">✓ compliant</Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-ink-500">
              Required {opGlyph(covenant.operator)}{" "}
              <span className="tabular-nums">{fmtNum(covenant.threshold)}</span>
              {unit}
              {covenant.description ? ` · ${covenant.description}` : ""}
            </p>
          </div>
          {latest ? (
            <div className="text-right">
              <div
                className={`text-lg font-bold tabular-nums ${breach ? "text-red-700" : "text-ink-900"}`}
              >
                {fmtNum(latest.value)}
                <span className="text-xs font-medium text-ink-400">{unit}</span>
              </div>
              <div
                className={`text-[11px] tabular-nums ${
                  (covenant.headroom ?? 0) < 0 ? "font-semibold text-red-600" : "text-ink-500"
                }`}
              >
                headroom {fmtNum(covenant.headroom)} · {formatDate(latest.readingDate)}
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-3">
          {readings === null ? (
            <Spinner label="Loading readings…" />
          ) : error ? (
            <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-100">
              {error}
            </div>
          ) : (
            <CovenantChart covenant={covenant} readings={readings} />
          )}
        </div>

        <form
          onSubmit={onAddReading}
          className="mt-3 flex flex-wrap items-end gap-2 border-t border-ink-100 pt-3"
        >
          <Field label="Reading date">
            <Input
              type="date"
              required
              value={rDate}
              onChange={(e) => setRDate(e.target.value)}
              className="w-36"
            />
          </Field>
          <Field label={`Value${unit ? ` (${covenant.unit})` : ""}`}>
            <Input
              type="number"
              step="any"
              required
              value={rValue}
              onChange={(e) => setRValue(e.target.value)}
              className="w-28"
            />
          </Field>
          <Field label="Note">
            <Input
              value={rNote}
              onChange={(e) => setRNote(e.target.value)}
              className="w-40"
              placeholder="optional"
            />
          </Field>
          <Button type="submit" size="sm" disabled={busy} className="mb-0.5">
            {busy ? "Recording…" : "Record reading"}
          </Button>
        </form>
        {formError ? <p className="mt-1.5 text-xs text-red-600">{formError}</p> : null}
      </CardBody>
    </Card>
  );
}
