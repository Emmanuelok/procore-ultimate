/**
 * THE PIPELINE — where the project's change exposure actually sits.
 *
 * Every lane is a stage of the chain, and a change event's lane is DERIVED
 * from the records underneath it: a PCO priced it, an RFQ went out, a COR was
 * put to the owner, a package executed. There is no "stage" column and the
 * board is deliberately not draggable, because a change does not move stage by
 * being dragged — it moves by somebody pricing, quoting, submitting or
 * executing it. Dragging a card would be a lie about what happened.
 *
 * Value per stage is shown PER CURRENCY. A project running a USD prime
 * contract and a EUR supply commitment gets two figures on the lane, never one
 * that is true of neither.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorAlert,
  SegmentedControl,
  Skeleton,
} from "../../ui";
import { KanbanBoard, KanbanCard, type KanbanColumn } from "../../ui/data";
import { ChartCard, FunnelChart, type FunnelStage as FunnelBar } from "../../ui/charts";
import { IconBoardView, IconChangeOrder } from "../../ui/icons";
import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_HINT,
  PIPELINE_STAGE_LABEL,
  Reasons,
  days,
  eventTone,
  label,
  money,
  stageEvents,
  type ChangeChain,
  type ChangeContext,
  type ChangeLogResponse,
  type PipelineStage,
  type StagedEvent,
} from "./changesShared";

const LANE_TONE: Record<PipelineStage, "neutral" | "warning" | "info" | "accent" | "success"> = {
  identified: "warning",
  priced: "info",
  quoted: "info",
  submitted: "accent",
  decided: "accent",
  executed: "success",
};

/** Per-currency totals for one lane. Never one number across currencies. */
function laneTotals(items: readonly StagedEvent[]): Array<{ currency: string | null; total: number }> {
  const buckets = new Map<string, { currency: string | null; total: number }>();
  for (const item of items) {
    const key = item.currency ?? "__unknown__";
    const bucket = buckets.get(key) ?? { currency: item.currency, total: 0 };
    bucket.total = Math.round((bucket.total + item.stageAmount) * 100) / 100;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) =>
    (a.currency ?? "ZZZ").localeCompare(b.currency ?? "ZZZ"),
  );
}

export default function PipelineTab({
  projectId,
  chain,
  context,
  changeLog,
  changeLogError,
}: {
  projectId: string;
  chain: ChangeChain;
  context: ChangeContext;
  changeLog: ChangeLogResponse | null;
  changeLogError: string | null;
}) {
  const navigate = useNavigate();
  const [view, setView] = useState<"board" | "funnel">("board");

  const staged = useMemo(
    () => stageEvents(chain, context.contractCurrency, context.commitmentCurrency),
    [chain, context.contractCurrency, context.commitmentCurrency],
  );

  const columns = useMemo<KanbanColumn[]>(
    () =>
      PIPELINE_STAGES.map((stage) => ({
        id: stage,
        title: PIPELINE_STAGE_LABEL[stage],
        description: PIPELINE_STAGE_HINT[stage],
        tone: LANE_TONE[stage],
        readOnly: true,
      })),
    [],
  );

  const funnelGroups = changeLog?.groups ?? [];

  if (chain.loading && staged.length === 0) {
    return (
      <div className="space-y-3">
        <Skeleton height={44} />
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {PIPELINE_STAGES.map((stage) => (
            <Skeleton key={stage} height={260} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorAlert message={chain.error} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-meta text-content-muted">
          {staged.length} live change event{staged.length === 1 ? "" : "s"} on the chain. Voided
          events are excluded; a lane is derived from what exists underneath the event.
        </div>
        <SegmentedControl<"board" | "funnel">
          value={view}
          onChange={setView}
          options={[
            { value: "board", label: "Board" },
            { value: "funnel", label: "Value at each stage" },
          ]}
          size="sm"
          aria-label="Pipeline view"
        />
      </div>

      {view === "board" ? (
        staged.length === 0 ? (
          <EmptyState
            icon={IconChangeOrder}
            title="No change events on this project"
            hint="A change event is the origin record for the whole chain — raise one the moment a condition arises, before anybody knows what it costs. Exposure identified and never priced is the commonest way a project leaks value."
          />
        ) : (
          <KanbanBoard
            aria-label="Change pipeline"
            columns={columns}
            items={staged}
            getItemId={(item) => item.event.id}
            getItemColumn={(item) => item.stage}
            height={620}
            emptyColumnText="Nothing at this stage"
            onCardClick={(item) =>
              navigate(`/projects/${projectId}/changes?tab=events&event=${item.event.id}`)
            }
            columnSummary={(items) => {
              const totals = laneTotals(items as StagedEvent[]);
              if (totals.length === 0) return <span className="text-2xs">No value at this stage</span>;
              return (
                <span className="flex flex-col gap-0.5">
                  {totals.map((bucket) => (
                    <span key={bucket.currency ?? "unknown"} className="tabular-nums">
                      {bucket.currency
                        ? money(bucket.total, bucket.currency)
                        : `${money(bucket.total, null)}`}
                    </span>
                  ))}
                </span>
              );
            }}
            renderCard={(item) => (
              <KanbanCard
                reference={item.event.reference}
                title={item.event.title}
                tone={eventTone(item.event.status)}
                badges={
                  <>
                    <Badge tone={eventTone(item.event.status)} size="xs">
                      {label(item.event.status)}
                    </Badge>
                    {item.event.scope === "out_of_scope" ? (
                      <Badge tone="warning" size="xs">
                        Out of scope
                      </Badge>
                    ) : item.event.scope === "tbd" ? (
                      <Badge tone="neutral" size="xs">
                        Scope TBD
                      </Badge>
                    ) : null}
                  </>
                }
                description={label(item.event.eventType)}
                meta={
                  <>
                    <span>{item.pcos.length} PCO</span>
                    <span>·</span>
                    <span>{item.quotes.length} RFQ</span>
                    <span>·</span>
                    <span>{item.cors.length} COR</span>
                    {item.event.scheduleImpactDays > 0 ? (
                      <>
                        <span>·</span>
                        <span>{days(item.event.scheduleImpactDays)} claimed</span>
                      </>
                    ) : null}
                  </>
                }
                footer={
                  <>
                    <span className="text-2xs text-content-subtle">{item.stageAmountBasis}</span>
                    <span className="font-medium tabular-nums text-content">
                      {item.currency ? (
                        money(item.stageAmount, item.currency)
                      ) : (
                        <span title="No contract or commitment on this event says what currency it is in.">
                          {money(item.stageAmount, null)}
                        </span>
                      )}
                    </span>
                  </>
                }
              />
            )}
          />
        )
      ) : (
        <div className="space-y-4">
          <ErrorAlert message={changeLogError} />
          {changeLog?.reasons.length ? (
            <Reasons reasons={changeLog.reasons} tone="warning" title="Mixed currency" />
          ) : null}
          {funnelGroups.length === 0 ? (
            <EmptyState
              size="sm"
              title="No reconciliation available"
              hint="The change log returned no currency group for this project, so there is no staged value to chart. That is not the same as zero."
            />
          ) : (
            funnelGroups.map((group) => {
              const stages: FunnelBar[] = group.funnel.map((s) => ({
                label: PIPELINE_STAGE_LABEL[s.stage as PipelineStage] ?? label(s.stage),
                value: s.events,
                note: `${money(s.amount, group.currency)} — ${s.description}`,
              }));
              return (
                <ChartCard
                  key={group.currency}
                  title={`Value at each stage — ${group.currency}`}
                  subtitle="Events counted, money valued at whatever that stage actually knows: ROM at identification, the PCO position once priced, what was asked at submission, what was granted at approval, what executed at execution."
                  icon={IconBoardView}
                  footnote="Figures are in one currency. Nothing on this chart is summed across currencies."
                >
                  <FunnelChart
                    data={stages}
                    ariaLabel={`Change funnel in ${group.currency}`}
                    height={280}
                  />
                </ChartCard>
              );
            })
          )}

          {funnelGroups.map((group) => (
            <Card key={`table-${group.currency}`}>
              <CardHeader
                title={`Stage detail — ${group.currency}`}
                subtitle="Each row names the basis of its own figure, because 'value' means a different number at each stage."
              />
              <CardBody className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-meta">
                  <thead>
                    <tr className="border-b border-border text-2xs uppercase tracking-wide text-content-subtle">
                      <th className="py-1.5 pr-3 text-left font-semibold">Stage</th>
                      <th className="py-1.5 pr-3 text-right font-semibold">Events</th>
                      <th className="py-1.5 pr-3 text-right font-semibold">Value</th>
                      <th className="py-1.5 text-left font-semibold">Basis</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {group.funnel.map((stage) => (
                      <tr key={stage.stage}>
                        <td className="py-2 pr-3 font-medium text-content">
                          {PIPELINE_STAGE_LABEL[stage.stage as PipelineStage] ?? label(stage.stage)}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-content">
                          {stage.events}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-content">
                          {money(stage.amount, group.currency)}
                        </td>
                        <td className="py-2 text-content-muted">{stage.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Alert tone="info" variant="subtle" size="sm" title="The board is not draggable, on purpose">
        A change event's stage is derived from the documents underneath it. To move one along, price
        a PCO, issue an RFQ, put a COR to the owner, or execute a package — each of which is a real
        record with a real author. Dragging a card would move the picture without moving the money.
        <div className="mt-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => navigate(`/projects/${projectId}/changes?tab=events`)}
          >
            Open the change events register
          </Button>
        </div>
      </Alert>
    </div>
  );
}
