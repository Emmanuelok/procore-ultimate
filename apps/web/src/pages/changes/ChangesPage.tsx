/**
 * CHANGE MANAGEMENT — the workspace for the whole chain, module M5.
 *
 *   change event  →  PCO  →  RFQ  →  COR  →  package (executed)
 *
 * The tabs are the chain, in order, with the pipeline in front of them and the
 * reconciliation behind them. Most systems model change as a list of change
 * orders; the money leaks in the gaps between the links — exposure identified
 * and never priced, priced and never submitted, submitted and quietly
 * discounted, executed on the owner side and never passed down to the
 * subcontract — and every one of those gaps is a stage transition that this
 * workspace counts.
 *
 * Deep links (`?tab=…&event=…&pco=…&cor=…&package=…&compare=…`) so a drawer can
 * be shared, and so the pipeline can hand a card to the register.
 */
import { useCallback, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { EmptyState, ErrorAlert, PageHeader, Tabs } from "../../ui";
import { IconChangeOrder } from "../../ui/icons";
import ChangeLogTab from "./ChangeLogTab";
import ConfigTab from "./ConfigTab";
import CorTab from "./CorTab";
import EventsTab from "./EventsTab";
import PackagesTab from "./PackagesTab";
import PcoTab from "./PcoTab";
import PipelineTab from "./PipelineTab";
import QuotesTab from "./QuotesTab";
import {
  useChangeChain,
  useChangeContext,
  useResource,
  type ChangeLogResponse,
} from "./changesShared";

const TABS = [
  { value: "pipeline", label: "Pipeline" },
  { value: "events", label: "Change events" },
  { value: "pcos", label: "Pricing (PCO)" },
  { value: "quotes", label: "Quotes (RFQ)" },
  { value: "cors", label: "Owner requests (COR)" },
  { value: "packages", label: "Execution" },
  { value: "log", label: "Change log" },
  { value: "config", label: "Configuration" },
] as const;

type TabKey = (typeof TABS)[number]["value"];

export default function ChangesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();

  const tab = useMemo<TabKey>(() => {
    const requested = params.get("tab");
    return TABS.some((t) => t.value === requested) ? (requested as TabKey) : "pipeline";
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

  const chain = useChangeChain(projectId ?? "");
  const context = useChangeContext(projectId ?? "");
  const changeLog = useResource<ChangeLogResponse>(
    projectId ? `/api/v1/projects/${projectId}/change-log` : null,
  );

  const counts = useMemo(
    () => ({
      events: chain.events.filter((e) => e.status !== "void").length,
      pcos: chain.pcos.filter((p) => !["void"].includes(p.status)).length,
      quotes: chain.quotes.filter((q) => q.status !== "void").length,
      cors: chain.cors.filter((c) => c.status !== "void").length,
      packages: chain.packages.filter((p) => p.status !== "void").length,
    }),
    [chain],
  );

  if (!projectId) {
    return (
      <EmptyState
        icon={IconChangeOrder}
        title="No project in the route"
        hint="Change management is project-scoped. Open it from a project."
      />
    );
  }

  return (
    <div>
      <PageHeader
        icon={IconChangeOrder}
        title="Change management"
        subtitle="The chain from a field event to money moving: identified → priced → quoted → submitted → approved → executed. Every gap between those is countable here."
        tabs={
          <Tabs<TabKey>
            items={TABS.map((t) => ({
              value: t.value,
              label: t.label,
              count:
                t.value === "events"
                  ? counts.events
                  : t.value === "pcos"
                    ? counts.pcos
                    : t.value === "quotes"
                      ? counts.quotes
                      : t.value === "cors"
                        ? counts.cors
                        : t.value === "packages"
                          ? counts.packages
                          : undefined,
            }))}
            value={tab}
            onChange={(next) => setParam("tab", next)}
            aria-label="Change management sections"
          />
        }
      />

      <ErrorAlert message={context.error} />

      {tab === "pipeline" ? (
        <PipelineTab
          projectId={projectId}
          chain={chain}
          context={context}
          changeLog={changeLog.data}
          changeLogError={changeLog.error}
        />
      ) : null}

      {tab === "events" ? (
        <EventsTab
          projectId={projectId}
          events={chain.events}
          loading={chain.loading}
          error={chain.error}
          reload={chain.reload}
          context={context}
          selectedEventId={params.get("event")}
          onSelectEvent={(id) => setParam("event", id)}
        />
      ) : null}

      {tab === "pcos" ? (
        <PcoTab
          projectId={projectId}
          chain={chain}
          context={context}
          selectedPcoId={params.get("pco")}
          onSelectPco={(id) => setParam("pco", id)}
          onOpenQuotes={(pcoId) => {
            setParams(
              (prev) => {
                const next = new URLSearchParams(prev);
                next.set("tab", "quotes");
                next.set("compare", pcoId);
                next.delete("pco");
                return next;
              },
              { replace: true },
            );
          }}
        />
      ) : null}

      {tab === "quotes" ? (
        <QuotesTab
          projectId={projectId}
          chain={chain}
          context={context}
          comparisonPcoId={params.get("compare")}
          onOpenComparison={(id) => setParam("compare", id)}
        />
      ) : null}

      {tab === "cors" ? (
        <CorTab
          projectId={projectId}
          chain={chain}
          context={context}
          selectedCorId={params.get("cor")}
          onSelectCor={(id) => setParam("cor", id)}
        />
      ) : null}

      {tab === "packages" ? (
        <PackagesTab
          projectId={projectId}
          chain={chain}
          context={context}
          selectedPackageId={params.get("package")}
          onSelectPackage={(id) => setParam("package", id)}
        />
      ) : null}

      {tab === "log" ? (
        <ChangeLogTab
          projectId={projectId}
          changeLog={changeLog.data}
          loading={changeLog.loading}
          error={changeLog.error}
          reload={changeLog.reload}
        />
      ) : null}

      {tab === "config" ? <ConfigTab projectId={projectId} context={context} /> : null}
    </div>
  );
}
