import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Modal,
  PageHeader,
  Spinner,
} from "../../ui";
import { formatDate, formatMoney, humanize } from "../format";
import {
  administratorLabel,
  contractStatusTone,
  eventStatusTone,
  formLabel,
  isNecForm,
  TabBar,
  type ContractDetail,
  type LdExposure,
} from "./contractsShared";
import { useCompanyUsers } from "../commercial/commercialShared";
import ClausesTab from "./ClausesTab";
import EventsTab from "./EventsTab";
import EotTab from "./EotTab";
import CeTab from "./CeTab";
import ProgrammesTab from "./ProgrammesTab";
import ComplianceTab from "./ComplianceTab";
import EditTermsModal from "./EditTermsModal";

const BASE_TABS = [
  { key: "overview", label: "Overview" },
  { key: "clauses", label: "Clauses" },
  { key: "events", label: "Events & Notices" },
  { key: "eot", label: "EOT Claims" },
  { key: "compliance", label: "Insurance & Bonds" },
];

const NEC_TABS = [
  { key: "ce", label: "Compensation Events" },
  { key: "programmes", label: "Programmes" },
];

const STATUS_ACTIONS: Record<string, { status: string; label: string; danger?: boolean }[]> = {
  draft: [{ status: "executed", label: "Execute contract" }],
  executed: [
    { status: "completed", label: "Mark completed" },
    { status: "terminated", label: "Terminate", danger: true },
  ],
};

const STATUS_CONFIRMATIONS: Record<string, string> = {
  executed:
    "Executing the contract locks its form and NEC option. Notices and claims will run against the executed terms.",
  completed: "Mark this contract as completed? No further status changes will be possible.",
  terminated: "Terminate this contract? This is final and cannot be reversed.",
};

export default function ContractDetailPage() {
  const { projectId, contractId } = useParams<{ projectId: string; contractId: string }>();
  const base = `/api/v1/projects/${projectId}/contracts/${contractId}`;
  const [searchParams, setSearchParams] = useSearchParams();

  const [contract, setContract] = useState<ContractDetail | null>(null);
  const [ld, setLd] = useState<LdExposure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState(searchParams.get("tab") ?? "overview");
  const [prefillClauseRef, setPrefillClauseRef] = useState<string | null>(null);

  const [pendingStatus, setPendingStatus] = useState<{ status: string; label: string } | null>(
    null,
  );
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { nameOf } = useCompanyUsers();

  const load = useCallback(async () => {
    if (!projectId || !contractId) return;
    setError(null);
    try {
      const [detail, exposure] = await Promise.all([
        api.get<ContractDetail>(base),
        api.get<LdExposure>(`${base}/ld-exposure`).catch(() => null),
      ]);
      setContract(detail);
      setLd(exposure);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the contract");
    } finally {
      setLoading(false);
    }
  }, [base, projectId, contractId]);

  useEffect(() => {
    void load();
  }, [load]);

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  function raiseEventUnderClause(clauseRef: string) {
    setPrefillClauseRef(clauseRef);
    selectTab("events");
  }

  async function onConfirmStatus() {
    if (!pendingStatus) return;
    setStatusError(null);
    setBusy(true);
    try {
      await api.post(`${base}/status`, { status: pendingStatus.status });
      setPendingStatus(null);
      await load();
    } catch (err) {
      setStatusError(
        err instanceof ApiClientError ? err.message : "Failed to change the contract status.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (error || !contract) {
    return (
      <div>
        <ErrorAlert message={error ?? "Contract not found"} />
        <Link
          to={`/projects/${projectId}/contracts`}
          className="text-sm font-medium text-brand-700 hover:text-brand-800"
        >
          ← Back to contracts
        </Link>
      </div>
    );
  }

  const actions = STATUS_ACTIONS[contract.status] ?? [];
  const totalEvents = Object.values(contract.eventCounts).reduce((a, b) => a + b, 0);
  const tabs = isNecForm(contract.form) ? [...BASE_TABS, ...NEC_TABS] : BASE_TABS;
  const editable = contract.status !== "completed" && contract.status !== "terminated";

  return (
    <div>
      <div className="mb-1 text-sm">
        <Link
          to={`/projects/${projectId}/contracts`}
          className="font-medium text-brand-700 hover:text-brand-800"
        >
          ← Contracts
        </Link>
      </div>
      <PageHeader
        title={contract.name}
        subtitle={`${formLabel(contract.form)}${contract.necOption ? ` · Option ${contract.necOption}` : ""}`}
        actions={
          <>
            <Badge tone={contractStatusTone(contract.status)}>{humanize(contract.status)}</Badge>
            {editable ? (
              <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
                Edit terms
              </Button>
            ) : null}
            {actions.map((a) => (
              <Button
                key={a.status}
                variant={a.danger ? "danger" : "primary"}
                size="sm"
                onClick={() => setPendingStatus(a)}
              >
                {a.label}
              </Button>
            ))}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone="blue">
          {contract.obligationCount} obligation{contract.obligationCount === 1 ? "" : "s"}
        </Badge>
        {contract.amendedClauseCount > 0 ? (
          <Badge tone="violet">
            {contract.amendedClauseCount} amended clause
            {contract.amendedClauseCount === 1 ? "" : "s"}
          </Badge>
        ) : null}
        {(contract.obligationStatus["breached"] ?? 0) > 0 ? (
          <Badge tone="red">{contract.obligationStatus["breached"]} breached</Badge>
        ) : null}
        {contract.calendarBasis === "working" ? (
          <Badge tone="gray">Working-day deadlines</Badge>
        ) : null}
        <Badge tone="gray">
          {totalEvents} event{totalEvents === 1 ? "" : "s"}
        </Badge>
        {Object.entries(contract.eventCounts).map(([s, n]) =>
          n > 0 ? (
            <Badge key={s} tone={eventStatusTone(s)}>
              {n} {humanize(s).toLowerCase()}
            </Badge>
          ) : null,
        )}
      </div>

      <TabBar tabs={tabs} active={tab} onSelect={selectTab} />

      {tab === "overview" ? <OverviewTab contract={contract} ld={ld} /> : null}
      {tab === "clauses" ? (
        <ClausesTab
          projectId={projectId!}
          contractId={contractId!}
          clauses={contract.effectiveClauses}
          particularConditions={contract.particularConditions}
          editable={editable}
          onRaiseEvent={raiseEventUnderClause}
          onChanged={load}
        />
      ) : null}
      {tab === "events" ? (
        <EventsTab
          projectId={projectId!}
          contractId={contractId!}
          clauses={contract.effectiveClauses}
          currency={contract.currency}
          prefillClauseRef={prefillClauseRef}
          onPrefillConsumed={() => setPrefillClauseRef(null)}
          onChanged={load}
        />
      ) : null}
      {tab === "eot" ? (
        <EotTab
          projectId={projectId!}
          contractId={contractId!}
          clauses={contract.effectiveClauses}
          completionDate={contract.completionDate}
          onChanged={load}
        />
      ) : null}
      {tab === "compliance" ? (
        <ComplianceTab
          projectId={projectId!}
          contractId={contractId!}
          currency={contract.currency}
        />
      ) : null}
      {tab === "ce" ? (
        <CeTab
          projectId={projectId!}
          contractId={contractId!}
          currency={contract.currency}
          necBasis={contract.necBasis}
          onChanged={load}
        />
      ) : null}
      {tab === "programmes" ? (
        <ProgrammesTab projectId={projectId!} contractId={contractId!} users={nameOf} />
      ) : null}

      <EditTermsModal
        open={editOpen}
        base={base}
        contract={contract}
        onClose={() => setEditOpen(false)}
        onSaved={async () => {
          setEditOpen(false);
          await load();
        }}
      />

      <Modal
        open={pendingStatus !== null}
        title={pendingStatus?.label ?? ""}
        onClose={() => setPendingStatus(null)}
      >
        <ErrorAlert message={statusError} />
        <p className="mb-4 text-sm text-ink-600">
          {pendingStatus ? (STATUS_CONFIRMATIONS[pendingStatus.status] ?? "Are you sure?") : ""}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPendingStatus(null)}>
            Cancel
          </Button>
          <Button
            variant={pendingStatus?.status === "terminated" ? "danger" : "primary"}
            disabled={busy}
            onClick={() => void onConfirmStatus()}
          >
            {busy ? "Working…" : (pendingStatus?.label ?? "Confirm")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/* ------------------------------- Overview tab ------------------------------ */

function OverviewTab({ contract, ld }: { contract: ContractDetail; ld: LdExposure | null }) {
  const adminLabel = administratorLabel(contract.form);
  const dates = [
    { label: "Base date", value: contract.baseDate },
    { label: "Commencement", value: contract.commencementDate },
    { label: "Completion", value: contract.completionDate },
    { label: "Taking-over", value: contract.takingOverDate },
  ];
  const applicable = ld !== null && ld.applicable;
  const capPct =
    applicable && ld.ldCap != null && ld.ldCap > 0
      ? Math.min(100, (ld.accrued / ld.ldCap) * 100)
      : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardBody>
          <h3 className="mb-3 text-sm font-semibold text-ink-900">Parties</h3>
          <dl className="space-y-3">
            {[
              { role: "Employer", value: contract.parties["employer"] },
              { role: "Contractor", value: contract.parties["contractor"] },
              { role: adminLabel, value: contract.parties["administrator"] },
            ].map((p) => (
              <div key={p.role} className="flex items-baseline justify-between gap-4">
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  {p.role}
                </dt>
                <dd className="text-right text-sm font-medium text-ink-800">{p.value || "—"}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h3 className="mb-3 text-sm font-semibold text-ink-900">Key dates</h3>
          <div className="flex items-start">
            {dates.map((d, i) => (
              <div key={d.label} className="flex flex-1 flex-col items-center text-center">
                <div className="flex w-full items-center">
                  <div
                    className={`h-px flex-1 ${i === 0 ? "bg-transparent" : d.value ? "bg-brand-300" : "bg-ink-200"}`}
                  />
                  <span
                    className={`h-3 w-3 shrink-0 rounded-full ring-2 ring-white ${d.value ? "bg-brand-600" : "bg-ink-300"}`}
                  />
                  <div
                    className={`h-px flex-1 ${i === dates.length - 1 ? "bg-transparent" : dates[i + 1]?.value ? "bg-brand-300" : "bg-ink-200"}`}
                  />
                </div>
                <div className="mt-2 text-xs font-medium uppercase tracking-wide text-ink-400">
                  {d.label}
                </div>
                <div className="mt-0.5 text-sm font-medium text-ink-800">
                  {formatDate(d.value)}
                </div>
              </div>
            ))}
          </div>
          {contract.defectsPeriodMonths != null ? (
            <p className="mt-4 text-xs text-ink-400">
              Defects notification period: {contract.defectsPeriodMonths} month
              {contract.defectsPeriodMonths === 1 ? "" : "s"} from completion.
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card className="lg:col-span-2">
        <CardBody>
          <h3 className="mb-3 text-sm font-semibold text-ink-900">Commercial terms</h3>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Contract sum
              </div>
              <div className="mt-0.5 text-xl font-semibold text-ink-900">
                {formatMoney(contract.contractSum, contract.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Retention
              </div>
              <div className="mt-0.5 text-xl font-semibold text-ink-900">
                {contract.retentionPercent}%
              </div>
              {contract.retentionCap != null ? (
                <div className="text-xs text-ink-400">
                  cap {formatMoney(contract.retentionCap, contract.currency)}
                </div>
              ) : null}
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                LD rate / day
              </div>
              <div className="mt-0.5 text-xl font-semibold text-ink-900">
                {formatMoney(contract.ldRatePerDay, contract.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">LD cap</div>
              <div className="mt-0.5 text-xl font-semibold text-ink-900">
                {formatMoney(contract.ldCap, contract.currency)}
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-md bg-ink-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Liquidated damages exposure
              </span>
              {applicable && ld.capReached ? <Badge tone="red">Cap reached</Badge> : null}
            </div>
            {!applicable ? (
              <p className="mt-1 text-sm text-ink-500">
                {ld && !ld.applicable
                  ? ld.reason
                  : "Not applicable — an LD rate and a completion date are required to compute exposure."}
              </p>
            ) : (
              <>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
                  <span
                    className={`text-2xl font-semibold ${ld.accrued > 0 ? "text-red-600" : "text-emerald-600"}`}
                  >
                    {formatMoney(ld.accrued, contract.currency)}
                  </span>
                  <span className="text-sm text-ink-500">
                    {ld.daysLate > 0
                      ? `${ld.daysLate} day${ld.daysLate === 1 ? "" : "s"} past completion (${formatDate(ld.completionDate)})`
                      : `on programme — completion ${formatDate(ld.completionDate)}`}
                  </span>
                  {ld.frozen ? <Badge tone="gray">Accrual stopped</Badge> : null}
                </div>
                {ld.accrualEndBasis ? (
                  <p className="mt-1 text-xs text-ink-500">{ld.accrualEndBasis}</p>
                ) : null}
                {capPct !== null ? (
                  <div className="mt-2">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-200">
                      <div
                        className={`h-full ${capPct >= 100 ? "bg-red-600" : capPct >= 60 ? "bg-amber-500" : "bg-emerald-500"}`}
                        style={{ width: `${capPct}%` }}
                      />
                    </div>
                    <div className="mt-1 text-xs text-ink-400">
                      {capPct.toFixed(0)}% of the {formatMoney(ld.ldCap, contract.currency)} cap
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
