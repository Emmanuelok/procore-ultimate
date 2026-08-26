/**
 * INVOICING — the money actually moving, module M6.
 *
 * Billing runs in both directions off the same schedule of values: owner
 * applications for payment against a prime contract, and subcontractor
 * invoices against a commitment. Same G702/G703 arithmetic, opposite sign,
 * two workflows that differ only in who signs.
 *
 * The tabs follow the month: the period that gates billing, the register of
 * what has been billed, the retainage nobody remembers, the waivers that
 * outlive the payment, and the reports that say where the cash actually is.
 *
 * Deep links (`?tab=…&period=…&invoice=…&release=…`) so a drawer can be shared.
 */
import { useCallback, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, EmptyState, ErrorAlert, PageHeader, Tabs } from "../../ui";
import { IconInvoice } from "../../ui/icons";
import InvoicesTab from "./InvoicesTab";
import PeriodsTab from "./PeriodsTab";
import ReportsTab from "./ReportsTab";
import RetainageTab from "./RetainageTab";
import WaiversTab from "./WaiversTab";
import { useInvoicingContext } from "./invoicingShared";

const TABS = [
  { value: "invoices", label: "Invoice register" },
  { value: "periods", label: "Billing periods" },
  { value: "retainage", label: "Retainage" },
  { value: "waivers", label: "Lien waivers" },
  { value: "reports", label: "Aging & cash" },
] as const;

type TabKey = (typeof TABS)[number]["value"];

export default function InvoicingPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();

  const tab = useMemo<TabKey>(() => {
    const requested = params.get("tab");
    return TABS.some((t) => t.value === requested) ? (requested as TabKey) : "invoices";
  }, [params]);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === null) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const context = useInvoicingContext(projectId ?? "");

  const openPeriods = useMemo(
    () => context.periods.filter((p) => p.status === "open").length,
    [context.periods],
  );

  if (!projectId) {
    return (
      <EmptyState
        icon={IconInvoice}
        title="No project in the route"
        hint="Invoicing is project-scoped. Open it from a project."
      />
    );
  }

  return (
    <div>
      <PageHeader
        icon={IconInvoice}
        title="Invoicing"
        subtitle="Owner applications for payment and subcontractor invoices, off one schedule of values. Every figure is per currency and nothing is ever summed across them."
        tabs={
          <Tabs<TabKey>
            items={TABS.map((t) => ({
              value: t.value,
              label: t.label,
              count: t.value === "periods" ? openPeriods : undefined,
            }))}
            value={tab}
            onChange={(next) => setParam("tab", next)}
            aria-label="Invoicing sections"
          />
        }
      />

      <ErrorAlert message={context.error} />

      {openPeriods === 0 && !context.loading ? (
        <Alert
          tone="warning"
          variant="subtle"
          size="sm"
          title="No open billing period"
          className="mb-4"
        >
          Nothing can be billed into a closed or locked period — that is the rule that makes a
          monthly cost report reproducible, not an error. Open a period on the Billing periods tab
          before raising invoices.
        </Alert>
      ) : null}

      {tab === "invoices" ? (
        <InvoicesTab
          projectId={projectId}
          context={context}
          selectedInvoiceId={params.get("invoice")}
          onSelectInvoice={(id) => setParam("invoice", id)}
        />
      ) : null}

      {tab === "periods" ? (
        <PeriodsTab
          projectId={projectId}
          context={context}
          selectedPeriodId={params.get("period")}
          onSelectPeriod={(id) => setParam("period", id)}
        />
      ) : null}

      {tab === "retainage" ? (
        <RetainageTab
          projectId={projectId}
          context={context}
          selectedReleaseId={params.get("release")}
          onSelectRelease={(id) => setParam("release", id)}
        />
      ) : null}

      {tab === "waivers" ? <WaiversTab projectId={projectId} context={context} /> : null}

      {tab === "reports" ? <ReportsTab projectId={projectId} /> : null}
    </div>
  );
}
