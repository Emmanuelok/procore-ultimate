/**
 * PRIME CONTRACT — the sell side of the project's money.
 *
 * Routed at /projects/:projectId/prime-contract.
 *
 * A project usually has one prime contract and occasionally has several, so
 * the page picks one and works on it: summary, schedule of values, progress
 * billing, and the change orders that move both. When a project holds primes
 * in more than one currency the portfolio strip shows them separately and
 * refuses to add them, exactly as the API's summary endpoint does.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Alert,
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
  Tabs,
} from "../../ui";
import { api } from "../../lib/api";
import BillingTab from "./BillingTab";
import ChangesTab from "./ChangesTab";
import SovTab from "./SovTab";
import SummaryTab from "./SummaryTab";
import {
  ComponentValue,
  MoneyStat,
  RefusalPanel,
  money,
  pct,
  useAction,
  useBillings,
  useChanges,
  useContract,
  useContractSummary,
  useContracts,
  useSov,
  useVendorNames,
} from "./shared";

type TabKey = "summary" | "sov" | "billing" | "changes";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "sov", label: "Schedule of values" },
  { value: "billing", label: "Progress billing" },
  { value: "changes", label: "Contract changes" },
];

export default function PrimeContractPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get("tab");
    return TABS.some((x) => x.value === t) ? (t as TabKey) : "summary";
  });
  const [contractId, setContractId] = useState<string | null>(
    () => searchParams.get("contract"),
  );

  const [executing, setExecuting] = useState(false);
  const [executionDate, setExecutionDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );

  const contracts = useContracts(projectId);
  const summary = useContractSummary(projectId);
  const vendorName = useVendorNames();
  const { busy, refusal, clear, run } = useAction();

  /* Default to the project's own prime once the list lands: the executed one
     if there is exactly one, otherwise the highest-numbered. */
  useEffect(() => {
    if (contractId !== null) return;
    const items = contracts.data?.items ?? [];
    if (items.length === 0) return;
    const executed = items.filter((c) => c.executed === 1);
    const chosen = executed.length === 1 ? executed[0] : items[0];
    if (chosen) setContractId(chosen.id);
  }, [contracts.data, contractId]);

  const contract = useContract(contractId);
  const sov = useSov(contractId);
  const changes = useChanges(contractId);
  const billings = useBillings(contractId);

  function reloadContract() {
    contract.reload();
    sov.reload();
    changes.reload();
    billings.reload();
    summary.reload();
    contracts.reload();
  }

  function selectTab(next: TabKey) {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params, { replace: true });
  }

  function selectContract(id: string) {
    setContractId(id);
    const params = new URLSearchParams(searchParams);
    params.set("contract", id);
    setSearchParams(params, { replace: true });
  }

  async function approve() {
    if (!contractId) return;
    const done = await run("approve", () =>
      api.post(`/api/v1/prime-contracts/${contractId}/approve`, {}),
    );
    if (done !== null) reloadContract();
  }

  async function execute(executionDate: string) {
    if (!contractId) return;
    const done = await run("execute", () =>
      api.post(`/api/v1/prime-contracts/${contractId}/execute`, { executionDate }),
    );
    if (done !== null) {
      setExecuting(false);
      reloadContract();
    }
  }

  const items = contracts.data?.items ?? [];
  const view = contract.data;

  const tabItems = useMemo(
    () =>
      TABS.map((t) => ({
        value: t.value,
        label: t.label,
        ...(t.value === "sov" && view && !view.sov.identity.ok
          ? { count: 1, tone: "danger" as const }
          : {}),
        ...(t.value === "billing" && billings.data
          ? { count: billings.data.items.length }
          : {}),
        ...(t.value === "changes" && changes.data ? { count: changes.data.items.length } : {}),
      })),
    [view, billings.data, changes.data],
  );

  if (!projectId) {
    return (
      <Alert tone="danger" title="No project in the route">
        This workspace is project-scoped and cannot resolve a prime contract without a project.
      </Alert>
    );
  }

  return (
    <div>
      <PageHeader
        title="Prime contract"
        subtitle="The owner-side agreement, its schedule of values, and progress billing against it — Σ SOV equals the contract sum on every write, and only an executed change order moves either."
        meta={
          view ? (
            <span>
              <span className="font-mono">{view.reference}</span> · {view.title} ·{" "}
              {view.currency}
            </span>
          ) : null
        }
        actions={
          items.length > 1 ? (
            <div className="w-72">
              <Field label="Contract" labelClassName="sr-only">
                <Select
                  value={contractId ?? ""}
                  onChange={(e) => selectContract(e.target.value)}
                  aria-label="Prime contract"
                >
                  {items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.reference} — {c.title} ({c.currency})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : null
        }
        tabs={
          contractId ? <Tabs items={tabItems} value={tab} onChange={selectTab} /> : undefined
        }
      />

      <ErrorAlert message={contracts.error} onRetry={contracts.reload} />
      <RefusalPanel refusal={refusal} onDismiss={clear} />

      <PortfolioStrip summary={summary.data} />

      {contracts.loading && items.length === 0 ? (
        <div className="py-12">
          <Spinner label="Loading prime contracts…" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No prime contract on this project"
          hint="A prime contract is the owner-side agreement: its sum, its schedule of values, and the applications for payment raised against it. Nothing has been recorded here yet."
        />
      ) : contract.loading && !view ? (
        <div className="py-12">
          <Spinner label="Loading the contract…" />
        </div>
      ) : contract.error ? (
        <ErrorAlert message={contract.error} onRetry={contract.reload} />
      ) : view ? (
        tab === "summary" ? (
          <SummaryTab
            contract={view}
            changes={changes.data?.items ?? []}
            vendorName={vendorName}
            busy={busy}
            onApprove={approve}
            onExecute={() => setExecuting(true)}
          />
        ) : tab === "sov" ? (
          <SovTab contract={view} sov={sov} onChanged={reloadContract} />
        ) : tab === "billing" ? (
          <BillingTab contract={view} billings={billings} onChanged={reloadContract} />
        ) : (
          <ChangesTab
            contract={view}
            changes={changes}
            sovLines={sov.data?.lines ?? []}
            onChanged={reloadContract}
          />
        )
      ) : null}

      <Modal
        open={executing}
        onClose={() => setExecuting(false)}
        title="Record execution"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setExecuting(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void execute(executionDate)}
              disabled={!executionDate || busy !== null}
            >
              Record it
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-meta text-content-muted">
            Execution is the date both parties signed. It cannot precede the award, and the API
            refuses a date that does — approval is the commercial decision, execution is the
            paperwork, and only an executed contract may be billed against.
          </p>
          <Field label="Execution date" required>
            <Input
              type="date"
              value={executionDate}
              onChange={(e) => setExecutionDate(e.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

/**
 * The project's prime-contract position, per currency. The API returns the
 * combined figure as a `Component` that is null with a reason whenever there is
 * more than one currency, and that null is rendered rather than papered over.
 */
function PortfolioStrip({
  summary,
}: {
  summary: import("./types").ContractSummary | null;
}) {
  if (!summary || summary.groups.length === 0) return null;
  const multi = summary.groups.length > 1;
  return (
    <div className="mb-4 space-y-2">
      {multi ? (
        <Alert tone="info" size="sm" title="More than one currency on this project">
          {summary.combinedRevisedContractSum.reasons.join(" ")}
        </Alert>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        {summary.groups.map((g) => (
          <Card key={g.currency}>
            <CardBody className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{g.currency}</span>
                <Badge tone="neutral" size="xs">
                  {g.executedCount} of {g.contractCount} executed
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MoneyStat
                  label="Revised sum"
                  value={g.revisedContractSum}
                  currency={g.currency}
                  size="sm"
                />
                <MoneyStat
                  label="Billed"
                  value={g.totalBilled}
                  currency={g.currency}
                  size="sm"
                  hint={
                    <ComponentValue
                      component={g.percentComplete}
                      render={(v) => `${pct(v)} complete`}
                    />
                  }
                />
                <MoneyStat
                  label="Retainage held"
                  value={g.retainageHeld}
                  currency={g.currency}
                  size="sm"
                />
                <MoneyStat
                  label="Balance to finish"
                  value={g.balanceToFinish}
                  currency={g.currency}
                  size="sm"
                />
              </div>
              {g.pendingChangeSum !== 0 ? (
                <p className="text-2xs text-content-subtle">
                  A further {money(g.pendingChangeSum, g.currency)} is priced but not executed, and
                  is deliberately outside the revised sum above.
                </p>
              ) : null}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
