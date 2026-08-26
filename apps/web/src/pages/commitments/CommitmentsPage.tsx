/**
 * COMMITMENTS — the buy side of the project's money.
 *
 * Routed at /projects/:projectId/commitments.
 *
 *   Register    every subcontract and purchase order, with the compliance
 *               position joined onto the row and per-currency totals that are
 *               never added together.
 *   Compliance  the certificate and bond register, worst first, with each
 *               finding printed in the words the compliance engine used.
 *   Buyout log  budget versus committed versus projected saving, per line.
 *
 * A commitment opens in a drawer over whichever tab you are on, so the
 * register keeps its place while a subcontract is worked on.
 */
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, PageHeader, Tabs } from "../../ui";
import BuyoutTab from "./BuyoutTab";
import CommitmentDrawer from "./CommitmentDrawer";
import ComplianceTab from "./ComplianceTab";
import RegisterTab from "./RegisterTab";
import {
  EMPTY_FILTERS,
  useBuyoutLog,
  useCommitmentRegister,
  useComplianceReport,
  useVendors,
  type RegisterFilters,
} from "./shared";

type TabKey = "register" | "compliance" | "buyout";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "register", label: "Register" },
  { value: "compliance", label: "Compliance" },
  { value: "buyout", label: "Buyout log" },
];

export default function CommitmentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get("tab");
    return TABS.some((x) => x.value === t) ? (t as TabKey) : "register";
  });
  const [filters, setFilters] = useState<RegisterFilters>(EMPTY_FILTERS);
  const [openId, setOpenId] = useState<string | null>(() => searchParams.get("commitment"));

  const register = useCommitmentRegister(projectId, filters);
  const compliance = useComplianceReport(projectId);
  const buyout = useBuyoutLog(projectId);
  const vendors = useVendors();

  function selectTab(next: TabKey) {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params, { replace: true });
  }

  function open(commitmentId: string | null) {
    setOpenId(commitmentId);
    const params = new URLSearchParams(searchParams);
    if (commitmentId) params.set("commitment", commitmentId);
    else params.delete("commitment");
    setSearchParams(params, { replace: true });
  }

  function refreshProjectLevel() {
    register.reload();
    compliance.reload();
    buyout.reload();
  }

  const blocked = compliance.data?.summary.paymentBlocked ?? 0;

  if (!projectId) {
    return (
      <Alert tone="danger" title="No project in the route">
        This workspace is project-scoped. It cannot show a register without knowing which project
        the register belongs to.
      </Alert>
    );
  }

  return (
    <div>
      <PageHeader
        title="Commitments"
        subtitle="Subcontracts and purchase orders — the schedule of values is the commitment sum, the sum moves only through change orders, and an expired certificate stops the payment."
        meta={
          compliance.data ? (
            <span>
              {compliance.data.summary.total} live commitment
              {compliance.data.summary.total === 1 ? "" : "s"} · {blocked} payment-blocked ·
              assessed {compliance.data.asOf}
            </span>
          ) : null
        }
        tabs={
          <Tabs
            items={TABS.map((t) => ({
              value: t.value,
              label: t.label,
              ...(t.value === "compliance" && blocked > 0
                ? { count: blocked, tone: "danger" as const }
                : {}),
            }))}
            value={tab}
            onChange={selectTab}
          />
        }
      />

      {tab === "register" ? (
        <RegisterTab
          register={register.data}
          compliance={compliance.data}
          vendors={vendors.data?.items ?? []}
          filters={filters}
          onFilters={setFilters}
          loading={register.loading}
          error={register.error}
          onReload={register.reload}
          onOpen={open}
        />
      ) : tab === "compliance" ? (
        <ComplianceTab report={compliance} onOpen={open} />
      ) : (
        <BuyoutTab log={buyout} />
      )}

      <CommitmentDrawer
        commitmentId={openId}
        buyoutRows={buyout.data?.rows ?? []}
        onClose={() => open(null)}
        onMutated={refreshProjectLevel}
      />
    </div>
  );
}
