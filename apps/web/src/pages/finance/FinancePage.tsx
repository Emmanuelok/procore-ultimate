/**
 * Project finance workspace — spec Vol II Domain O / M14: funding facility
 * register (#729), committed / disbursed / undisbursed monitoring (#740-741),
 * open-condition and covenant status at a glance (#730-731, #742), with the
 * facility detail carrying the conditionality-gated disbursement pipeline.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { FACILITY_INSTRUMENTS } from "@constructos/shared";
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
  PageHeader,
  Select,
  Spinner,
  Textarea,
} from "../../ui";
import { formatDate, humanize } from "../format";
import FacilityDetail from "./FacilityDetail";
import {
  ClosingCountdown,
  DisbursedBar,
  fmtMoney,
  instrumentTone,
  type FacilityRow,
  type FinanceSummary,
  type ListResponse,
} from "./financeShared";

function Stat({
  label,
  value,
  tone,
  emphasized,
}: {
  label: string;
  value: ReactNode;
  tone?: "red" | "amber" | "green" | "brand";
  emphasized?: boolean;
}) {
  const valueCls =
    tone === "red"
      ? "text-red-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "green"
          ? "text-emerald-700"
          : tone === "brand"
            ? "text-brand-700"
            : "text-ink-900";
  return (
    <Card className={emphasized ? "ring-2 ring-brand-200" : undefined}>
      <CardBody className="px-4 py-3">
        <div className={`${emphasized ? "text-2xl" : "text-xl"} font-bold tabular-nums ${valueCls}`}>
          {value}
        </div>
        <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-400">
          {label}
        </div>
      </CardBody>
    </Card>
  );
}

function CovenantStatusChip({ status }: { status: FinanceSummary["covenantStatus"] }) {
  if (status === null) return <Badge tone="gray">No covenants</Badge>;
  if (status === "breached") return <Badge tone="red">✗ Covenant breach</Badge>;
  if (status === "unknown") return <Badge tone="amber">Readings missing</Badge>;
  return <Badge tone="green">✓ Covenants compliant</Badge>;
}

interface CategoryDraft {
  name: string;
  limit: string;
}

export default function FinancePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}`;

  const [facilities, setFacilities] = useState<FacilityRow[] | null>(null);
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const [list, sum] = await Promise.all([
        api.get<ListResponse<FacilityRow>>(`${base}/facilities?pageSize=100`),
        api.get<FinanceSummary>(`${base}/finance/summary`),
      ]);
      setFacilities(list.items);
      setSummary(sum);
    } catch (err) {
      setFacilities([]);
      setError(err instanceof Error ? err.message : "Failed to load project finance");
    }
  }, [base, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------ create modal ------------------------------ */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fName, setFName] = useState("");
  const [fLender, setFLender] = useState("");
  const [fInstrument, setFInstrument] = useState<string>("loan");
  const [fCurrency, setFCurrency] = useState("GBP");
  const [fCommitted, setFCommitted] = useState("");
  const [fClosing, setFClosing] = useState("");
  const [fNotes, setFNotes] = useState("");
  const [fCategories, setFCategories] = useState<CategoryDraft[]>([]);

  function openCreate() {
    setCreateError(null);
    setFName("");
    setFLender("");
    setFInstrument("loan");
    setFCurrency("GBP");
    setFCommitted("");
    setFClosing("");
    setFNotes("");
    setFCategories([]);
    setCreateOpen(true);
  }

  function setCategory(i: number, patch: Partial<CategoryDraft>) {
    setFCategories((cats) => cats.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  const categoryTotal = fCategories.reduce((s, c) => s + (Number(c.limit) || 0), 0);
  const committedNum = Number(fCommitted) || 0;
  const overAllocated = committedNum > 0 && categoryTotal > committedNum;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: fName.trim(),
        lender: fLender.trim(),
        instrument: fInstrument,
        committedAmount: Number(fCommitted),
      };
      const cur = fCurrency.trim().toUpperCase();
      if (cur) payload["currency"] = cur;
      if (fClosing) payload["availabilityEndDate"] = fClosing;
      if (fNotes.trim()) payload["notes"] = fNotes.trim();
      const cats = fCategories
        .filter((c) => c.name.trim() && Number(c.limit) > 0)
        .map((c) => ({ name: c.name.trim(), limit: Number(c.limit) }));
      if (cats.length > 0) payload["categories"] = cats;
      const created = await api.post<FacilityRow>(`${base}/facilities`, payload);
      setCreateOpen(false);
      await load();
      setSelectedId(created.id);
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the facility.");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- render --------------------------------- */

  if (!projectId) return null;

  if (selectedId) {
    return (
      <FacilityDetail
        projectId={projectId}
        facilityId={selectedId}
        onBack={() => setSelectedId(null)}
        onChanged={() => void load()}
      />
    );
  }

  const currency = facilities?.[0]?.currency ?? "GBP";

  return (
    <div>
      <PageHeader
        title="Project Finance"
        subtitle="Funding facilities, lender conditionality, disbursements and covenant compliance"
        actions={<Button onClick={openCreate}>New facility</Button>}
      />

      {/* summary strip */}
      {summary ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Committed" value={fmtMoney(summary.committed, currency)} />
          <Stat label="Disbursed" value={fmtMoney(summary.disbursed, currency)} />
          <Stat
            label="Undisbursed"
            value={fmtMoney(summary.undisbursed, currency)}
            tone="brand"
            emphasized
          />
          <Stat
            label="Pending requests"
            value={summary.pendingRequests}
            tone={summary.pendingRequests > 0 ? "amber" : undefined}
          />
          <Stat
            label="Open conditions"
            value={summary.openConditions}
            tone={summary.openConditions > 0 ? "amber" : "green"}
          />
          <Card>
            <CardBody className="flex h-full flex-col justify-center px-4 py-3">
              <CovenantStatusChip status={summary.covenantStatus} />
              <div className="mt-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">
                Covenant status
              </div>
            </CardBody>
          </Card>
        </div>
      ) : null}

      <ErrorAlert message={error} />

      {/* facility register (#729) */}
      {facilities === null ? (
        <Spinner />
      ) : facilities.length === 0 ? (
        <EmptyState
          title="No funding facilities yet"
          hint="Register the project's funding facilities — lender, instrument, committed amount and allocation categories — to start tracking conditions and disbursements."
          action={<Button onClick={openCreate}>Register the first facility</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {facilities.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setSelectedId(f.id)}
              className="rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardBody>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-ink-900">{f.name}</span>
                        <Badge tone={instrumentTone(f.instrument)}>{humanize(f.instrument)}</Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-500">{f.lender}</p>
                    </div>
                    <ClosingCountdown days={f.daysToClosing} />
                  </div>

                  <div className="mt-3">
                    <div className="mb-1 flex items-baseline justify-between text-xs">
                      <span className="text-ink-500">
                        Disbursed{" "}
                        <span className="font-medium tabular-nums text-ink-800">
                          {fmtMoney(f.disbursed, f.currency)}
                        </span>
                      </span>
                      <span className="tabular-nums text-ink-500">
                        of {fmtMoney(f.committedAmount, f.currency)}
                      </span>
                    </div>
                    <DisbursedBar committed={f.committedAmount} disbursed={f.disbursed} />
                    <div className="mt-1.5 text-xs text-ink-600">
                      Undisbursed{" "}
                      <span className="font-semibold tabular-nums text-brand-700">
                        {fmtMoney(f.undisbursed, f.currency)}
                      </span>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-2.5 text-xs text-ink-500">
                    <span
                      className={
                        f.openConditions > 0 ? "font-semibold text-amber-700" : undefined
                      }
                    >
                      {f.openConditions} open condition{f.openConditions === 1 ? "" : "s"}
                    </span>
                    <span aria-hidden>·</span>
                    <span>
                      {f.pendingRequests} pending request{f.pendingRequests === 1 ? "" : "s"}
                    </span>
                    {f.availabilityEndDate ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>closing {formatDate(f.availabilityEndDate)}</span>
                      </>
                    ) : null}
                  </div>
                </CardBody>
              </Card>
            </button>
          ))}
        </div>
      )}

      {/* ------------------------------ create modal ------------------------------ */}
      <Modal open={createOpen} title="New funding facility" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Facility name">
              <Input
                required
                value={fName}
                onChange={(e) => setFName(e.target.value)}
                placeholder="Senior construction loan — Tranche A"
              />
            </Field>
            <Field label="Lender">
              <Input
                required
                value={fLender}
                onChange={(e) => setFLender(e.target.value)}
                placeholder="African Development Bank"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Instrument">
              <Select value={fInstrument} onChange={(e) => setFInstrument(e.target.value)}>
                {FACILITY_INSTRUMENTS.map((i) => (
                  <option key={i} value={i}>
                    {humanize(i)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Committed amount">
              <Input
                type="number"
                min="0.01"
                step="any"
                required
                value={fCommitted}
                onChange={(e) => setFCommitted(e.target.value)}
              />
            </Field>
            <Field label="Currency">
              <Input
                value={fCurrency}
                maxLength={3}
                onChange={(e) => setFCurrency(e.target.value)}
                placeholder="GBP"
              />
            </Field>
            <Field label="Closing date" hint="Availability end (#741).">
              <Input type="date" value={fClosing} onChange={(e) => setFClosing(e.target.value)} />
            </Field>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-600">
                Allocation categories{" "}
                <span className="font-normal text-ink-400">
                  — optional limits per expenditure category (#739)
                </span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setFCategories((c) => [...c, { name: "", limit: "" }])}
              >
                Add category
              </Button>
            </div>
            {fCategories.length === 0 ? (
              <p className="rounded-md border border-dashed border-ink-200 px-3 py-2.5 text-center text-xs text-ink-400">
                No categories — the whole commitment is drawable without per-category limits.
              </p>
            ) : (
              <div className="space-y-2">
                {fCategories.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={c.name}
                      onChange={(e) => setCategory(i, { name: e.target.value })}
                      placeholder={`Category ${i + 1} — e.g. Civil works`}
                      className="flex-1"
                    />
                    <Input
                      type="number"
                      min="0.01"
                      step="any"
                      value={c.limit}
                      onChange={(e) => setCategory(i, { limit: e.target.value })}
                      placeholder="Limit"
                      className="w-36"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove category ${i + 1}`}
                      onClick={() => setFCategories((cats) => cats.filter((_, j) => j !== i))}
                    >
                      ✕
                    </Button>
                  </div>
                ))}
                <p
                  className={`text-xs tabular-nums ${
                    overAllocated ? "font-semibold text-red-600" : "text-ink-400"
                  }`}
                >
                  Category limits total {fmtMoney(categoryTotal, fCurrency || "GBP")}
                  {committedNum > 0 ? ` of ${fmtMoney(committedNum, fCurrency || "GBP")} committed` : ""}
                  {overAllocated ? " — exceeds the committed amount" : ""}
                </p>
              </div>
            )}
          </div>

          <Field label="Notes">
            <Textarea
              value={fNotes}
              onChange={(e) => setFNotes(e.target.value)}
              className="min-h-12"
              placeholder="Facility agreement dated…, margin, repayment profile…"
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || overAllocated}>
              {busy ? "Creating…" : "Create facility"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
