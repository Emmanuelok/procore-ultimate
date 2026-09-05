/**
 * PIPELINE — the decision that is taken before a bid package exists.
 *
 * By the time a tender register has a row in it, somebody has already made
 * the decision that costs the most money to get wrong: whether to chase this
 * job at all. This screen models it as a gate with three parts kept
 * deliberately apart, because conflating them is how a hunch acquires a
 * decimal point:
 *
 *   THE SCORE        a weighted judgement the bid team records. It suggests.
 *   THE PROBABILITY  an inference FITTED from this company's own outcomes,
 *                    and refused with its reasons where the history is too
 *                    thin to fit anything. It never fills a gap with a base
 *                    rate wearing a decimal point.
 *   THE DECISION     what was actually decided, and why — recorded whether or
 *                    not it agreed with either. The disagreements are the
 *                    interesting ones, and the screen says so.
 *
 * And the cost. Tendering is the largest unmeasured overhead in most
 * contracting businesses; the cost-of-sale panel turns "we spend a fortune on
 * bids we lose" into a figure with a currency on it.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Input,
  Modal,
  Progress,
  Select,
  Stat,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import type { DataColumns } from "../../ui";
import { IconTarget, IconTrendUp, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  Figure,
  LoadError,
  LoadingBlock,
  ReasonList,
  RefusalPanel,
  dateTime,
  isoDate,
  money,
  num,
  pct,
  titleCase,
  useAction,
  useResource,
} from "./biddingShared";
import type {
  CostOfSaleReport,
  Opportunity,
  OpportunityList,
  WinProbabilityResult,
} from "./types";

const STAGES = [
  "identified",
  "qualifying",
  "bid_no_bid",
  "bidding",
  "submitted",
  "shortlisted",
  "won",
  "lost",
  "no_bid",
  "abandoned",
] as const;

const FACTORS = [
  "client_relationship",
  "sector_experience",
  "geography",
  "capacity",
  "competition",
  "margin_potential",
  "risk_profile",
  "contract_terms",
  "programme",
  "strategic_value",
  "financial_standing",
  "resource_availability",
] as const;

const SOURCES = [
  "public_notice",
  "framework_call_off",
  "direct_approach",
  "repeat_client",
  "referral",
  "portal",
  "competition",
  "other",
] as const;

const stageTone = (stage: string) =>
  stage === "won"
    ? "success"
    : stage === "lost" || stage === "abandoned"
      ? "danger"
      : stage === "no_bid"
        ? "neutral"
        : stage === "submitted" || stage === "shortlisted"
          ? "info"
          : "highlight";

export default function PipelineTab() {
  const [version, setVersion] = useState(0);
  const [liveOnly, setLiveOnly] = useState(false);
  const list = useResource<OpportunityList>(
    `/api/v1/companies/current/opportunities?page=1&pageSize=200${liveOnly ? "&liveOnly=true" : ""}&_v=${version}`,
  );
  const costs = useResource<CostOfSaleReport>(
    `/api/v1/companies/current/cost-of-sale?_v=${version}`,
  );
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = () => setVersion((n) => n + 1);

  const detail = useResource<Opportunity>(
    openId ? `/api/v1/companies/current/opportunities/${openId}?_v=${version}` : null,
  );

  const columns: DataColumns<Opportunity> = useMemo(
    () => [
      {
        id: "reference",
        header: "Pursuit",
        accessor: (o) => o.title,
        type: "text",
        width: 260,
        sticky: "start",
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.title}</p>
            <p className="text-2xs text-content-subtle">
              {row.reference}
              {row.clientDisplayName ? ` · ${row.clientDisplayName}` : ""}
            </p>
          </div>
        ),
      },
      {
        id: "stage",
        header: "Stage",
        accessor: (o) => o.stage,
        width: 140,
        cell: ({ row }) => (
          <div className="space-y-1">
            <Badge tone={stageTone(row.stage)} size="xs" dot>
              {titleCase(row.stage)}
            </Badge>
            {row.bidNoBidDecision !== "pending" ? (
              <p className="text-2xs text-content-subtle">
                decided {titleCase(row.bidNoBidDecision)}
              </p>
            ) : (
              <p className="text-2xs text-warning-fg">gate not passed</p>
            )}
          </div>
        ),
      },
      {
        id: "value",
        header: "Value",
        accessor: (o) => o.estimatedValue,
        width: 150,
        align: "right",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.estimatedValue === null ? (
              <span className="italic text-content-subtle">not estimated</span>
            ) : (
              money(row.estimatedValue, row.currency)
            )}
          </span>
        ),
      },
      {
        id: "probability",
        header: "Win probability",
        accessor: (o) => o.winProbability,
        width: 170,
        cell: ({ row }) =>
          row.winProbability === null ? (
            <span className="text-2xs italic text-content-subtle">
              not modelled — too little outcome history
            </span>
          ) : (
            <div className="min-w-0">
              <Progress value={row.winProbability * 100} max={100} size="sm" />
              <p className="mt-0.5 tabular-nums text-2xs text-content-subtle">
                {pct(row.winProbability * 100, 0)} · {row.winProbabilityModel}
              </p>
            </div>
          ),
      },
      {
        id: "score",
        header: "Bid score",
        accessor: (o) => o.bidNoBidScore,
        width: 110,
        align: "right",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.bidNoBidScore === null ? "—" : `${num(row.bidNoBidScore, 0)}/100`}
          </span>
        ),
      },
      {
        id: "due",
        header: "Submission due",
        accessor: (o) => o.submissionDueAt,
        width: 170,
        cell: ({ row }) => (
          <span className="text-meta">{dateTime(row.submissionDueAt)}</span>
        ),
      },
      {
        id: "outcome",
        header: "Outcome",
        accessor: (o) => o.outcome,
        width: 150,
        cell: ({ row }) =>
          row.outcome ? (
            <div>
              <Badge tone={row.outcome === "won" ? "success" : "neutral"} size="xs">
                {titleCase(row.outcome)}
              </Badge>
              {row.winningCompetitor ? (
                <p className="mt-0.5 text-2xs text-content-subtle">
                  to {row.winningCompetitor}
                </p>
              ) : null}
            </div>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
    ],
    [],
  );

  if (list.loading && !list.data) return <LoadingBlock rows={6} />;
  if (list.error) return <LoadError message={list.error} onRetry={list.reload} />;

  const data = list.data;
  const pipeline = data?.pipeline ?? [];
  const capacity = data?.capacity;

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalPanel refusal={action.refusal} onDismiss={action.clear} /> : null}

      {/* -------------------------------------------------------- */}
      {/* The pipeline itself, bucketed per currency                */}
      {/* -------------------------------------------------------- */}
      {pipeline.length === 0 ? null : (
        <div className="grid gap-3 lg:grid-cols-2">
          {pipeline.map((bucket) => (
            <Card key={bucket.currency}>
              <CardHeader
                title={`Pipeline in ${bucket.currency}`}
                subtitle="Never summed across currencies — the totals below describe this currency only."
              />
              <CardBody>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Stat label="Live pursuits" value={String(bucket.liveCount)} />
                  <Stat
                    label="Live value"
                    value={
                      bucket.liveValue === null ? "—" : money(bucket.liveValue, bucket.currency)
                    }
                  />
                  <div>
                    <div className="text-label uppercase text-content-subtle">Weighted value</div>
                    <Figure
                      figure={bucket.weightedValue}
                      className="mt-0.5 block text-base font-semibold tabular-nums"
                      render={(v) => <>{money(v, bucket.currency)}</>}
                    />
                    {bucket.weightedValue.value !== null ? (
                      <p className="mt-0.5 text-2xs text-content-subtle">
                        from {bucket.weightedFrom} pursuit(s) that carry a modelled probability
                        {bucket.unweighted > 0
                          ? `; ${bucket.unweighted} live pursuit(s) are not weighted at all`
                          : ""}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 space-y-1">
                  {bucket.stages.map((s) => (
                    <div key={s.stage} className="flex items-center gap-2 text-meta">
                      <span className="w-32 shrink-0 text-content-subtle">
                        {titleCase(s.stage)}
                      </span>
                      <Progress
                        value={s.count}
                        max={Math.max(...bucket.stages.map((x) => x.count), 1)}
                        size="sm"
                        className="flex-1"
                      />
                      <span className="w-10 shrink-0 text-right tabular-nums">{s.count}</span>
                      <span className="w-28 shrink-0 text-right tabular-nums text-content-subtle">
                        {s.value === null ? "—" : money(s.value, bucket.currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {capacity ? (
        <Alert
          tone={capacity.pursued === null ? "info" : "warning"}
          icon={IconTrendUp}
          title="Capacity"
        >
          <p className="whitespace-pre-wrap">{capacity.note}</p>
        </Alert>
      ) : null}

      {/* -------------------------------------------------------- */}
      {/* The register                                              */}
      {/* -------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Opportunities"
          subtitle="Every pursuit, its gate decision and what happened next. An outcome nobody records teaches the model nothing."
          actions={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={liveOnly ? "primary" : "ghost"}
                onClick={() => setLiveOnly((v) => !v)}
              >
                {liveOnly ? "Showing live only" : "Show live only"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
                Add a pursuit
              </Button>
            </div>
          }
        />
        <CardBody flush>
          <DataTable<Opportunity>
            tableId="bidding.opportunities"
            data={data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            height={460}
            rowHeight={62}
            stickyHeader
            exportFileName="bid-opportunities"
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) =>
              row.bidNoBidDecision === "pending" && row.submissionDueAt !== null
                ? "warning"
                : undefined
            }
            empty={{
              title: "No pursuits recorded",
              description:
                "The pipeline starts before the tender does. Record what the business is chasing and the bid/no-bid decision becomes reviewable.",
            }}
          />
        </CardBody>
      </Card>

      {/* -------------------------------------------------------- */}
      {/* Cost of sale                                              */}
      {/* -------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Cost of sale"
          subtitle="What winning work costs, with every loss counted against it."
        />
        <CardBody>
          {costs.loading && !costs.data ? (
            <LoadingBlock rows={2} />
          ) : costs.error ? (
            <LoadError message={costs.error} onRetry={costs.reload} />
          ) : !costs.data || costs.data.currencies.length === 0 ? (
            <EmptyState
              title="No tender costs recorded"
              hint={
                costs.data?.note ??
                "Until the hours are recorded, the cost of winning work is an overhead line rather than a figure attributable to the tenders that produced it."
              }
            />
          ) : (
            <div className="space-y-4">
              {costs.data.currencies.map((c) => (
                <div key={c.currency} className="rounded-lg border border-border p-3">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                    <Stat label={`Total (${c.currency})`} value={money(c.totalCost, c.currency)} />
                    <Stat label="On wins" value={money(c.wonCost, c.currency)} />
                    <Stat label="On losses" value={money(c.lostCost, c.currency)} />
                    <div>
                      <div className="text-label uppercase text-content-subtle">Cost per win</div>
                      <Figure
                        figure={c.costPerWin}
                        className="mt-0.5 block text-base font-semibold tabular-nums"
                        render={(v) => <>{money(v, c.currency)}</>}
                      />
                    </div>
                    <div>
                      <div className="text-label uppercase text-content-subtle">
                        Cost of sale %
                      </div>
                      <Figure
                        figure={c.costOfSalePercent}
                        className="mt-0.5 block text-base font-semibold tabular-nums"
                        render={(v) => <>{pct(v, 2)}</>}
                      />
                    </div>
                  </div>
                  <p className="mt-2 text-meta leading-relaxed text-content-muted">{c.note}</p>
                  {c.byKind.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {c.byKind.map((k) => (
                        <Badge key={k.kind} tone="neutral" size="xs" variant="subtle">
                          {titleCase(k.kind)} {money(k.cost, c.currency)} ({pct(k.sharePercent, 0)})
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <CreateOpportunityModal
        open={creating}
        onClose={() => setCreating(false)}
        action={action}
        onDone={() => {
          setCreating(false);
          refresh();
        }}
      />

      <OpportunityDrawer
        open={openId !== null}
        opportunity={detail.data}
        loading={detail.loading}
        onClose={() => setOpenId(null)}
        action={action}
        onChanged={() => {
          refresh();
          detail.reload();
        }}
      />
    </div>
  );
}

/* ================================================================== */
/* Create                                                              */
/* ================================================================== */

function CreateOpportunityModal({
  open,
  onClose,
  action,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  action: ReturnType<typeof useAction>;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [clientName, setClientName] = useState("");
  const [workType, setWorkType] = useState("");
  const [sector, setSector] = useState("");
  const [source, setSource] = useState<string>("other");
  const [estimatedValue, setEstimatedValue] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const [submissionDueAt, setSubmissionDueAt] = useState("");
  const [peakResourceUnits, setPeakResourceUnits] = useState("");
  const [resourceUnitLabel, setResourceUnitLabel] = useState("crews");

  async function submit() {
    const res = await action.run("create", () =>
      api.post<Opportunity>("/api/v1/companies/current/opportunities", {
        title,
        clientName: clientName || null,
        workType: workType || null,
        sector: sector || null,
        source,
        estimatedValue: estimatedValue ? Number(estimatedValue) : null,
        currency,
        submissionDueAt: submissionDueAt ? new Date(submissionDueAt).toISOString() : null,
        peakResourceUnits: peakResourceUnits ? Number(peakResourceUnits) : null,
        resourceUnitLabel: peakResourceUnits ? resourceUnitLabel : null,
      }),
    );
    if (!res) return;
    setTitle("");
    setClientName("");
    setEstimatedValue("");
    setSubmissionDueAt("");
    onDone();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a pursuit"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!title.trim()}
            loading={action.busy === "create"}
            onClick={() => void submit()}
          >
            Add
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client">
            <Input value={clientName} onChange={(e) => setClientName(e.target.value)} />
          </Field>
          <Field label="Source">
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Work type" hint="Used by the win model to compare like with like.">
            <Input value={workType} onChange={(e) => setWorkType(e.target.value)} />
          </Field>
          <Field label="Sector">
            <Input value={sector} onChange={(e) => setSector(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Estimated value">
            <Input
              type="number"
              value={estimatedValue}
              onChange={(e) => setEstimatedValue(e.target.value)}
            />
          </Field>
          <Field label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Submission due">
            <Input
              type="datetime-local"
              value={submissionDueAt}
              onChange={(e) => setSubmissionDueAt(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Resource if won"
            hint="What winning it would consume, so the pipeline can say whether it is deliverable."
          >
            <Input
              type="number"
              value={peakResourceUnits}
              onChange={(e) => setPeakResourceUnits(e.target.value)}
            />
          </Field>
          <Field label="Unit">
            <Input
              value={resourceUnitLabel}
              onChange={(e) => setResourceUnitLabel(e.target.value)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* The drawer: gate, probability, outcome, costs                       */
/* ================================================================== */

function OpportunityDrawer({
  open,
  opportunity,
  loading,
  onClose,
  action,
  onChanged,
}: {
  open: boolean;
  opportunity: Opportunity | null;
  loading: boolean;
  onClose: () => void;
  action: ReturnType<typeof useAction>;
  onChanged: () => void;
}) {
  const [factors, setFactors] = useState<Record<string, { score: string; weight: string }>>({});
  const [basis, setBasis] = useState("");
  const [decision, setDecision] = useState("bid");
  const [probability, setProbability] = useState<WinProbabilityResult | null>(null);
  const [outcome, setOutcome] = useState("lost");
  const [outcomeReason, setOutcomeReason] = useState("");
  const [submittedAmount, setSubmittedAmount] = useState("");
  const [winner, setWinner] = useState("");
  const [costKind, setCostKind] = useState("estimating_labour");
  const [costHours, setCostHours] = useState("");
  const [costRate, setCostRate] = useState("");
  const [costDescription, setCostDescription] = useState("");

  const scored = useMemo(
    () =>
      Object.entries(factors)
        .filter(([, v]) => v.score !== "" && v.weight !== "")
        .map(([factor, v]) => ({
          factor,
          score: Number(v.score),
          weight: Number(v.weight),
        })),
    [factors],
  );

  async function computeProbability() {
    if (!opportunity) return;
    const res = await action.run("probability", () =>
      api.post<WinProbabilityResult>(
        `/api/v1/companies/current/opportunities/${opportunity.id}/win-probability`,
        {},
      ),
    );
    if (res) {
      setProbability(res);
      onChanged();
    }
  }

  async function decide() {
    if (!opportunity) return;
    const res = await action.run("decide", () =>
      api.post(`/api/v1/companies/current/opportunities/${opportunity.id}/decide`, {
        decision,
        factors: scored,
        basis,
      }),
    );
    if (res) {
      setBasis("");
      onChanged();
    }
  }

  async function recordOutcome() {
    if (!opportunity) return;
    const res = await action.run("outcome", () =>
      api.post(`/api/v1/companies/current/opportunities/${opportunity.id}/outcome`, {
        outcome,
        ...(outcomeReason ? { reason: outcomeReason } : {}),
        ...(submittedAmount ? { submittedAmount: Number(submittedAmount) } : {}),
        ...(winner ? { winningCompetitor: winner } : {}),
      }),
    );
    if (res) {
      setOutcomeReason("");
      onChanged();
    }
  }

  async function addCost() {
    if (!opportunity) return;
    const res = await action.run("cost", () =>
      api.post("/api/v1/companies/current/tender-costs", {
        opportunityId: opportunity.id,
        kind: costKind,
        description: costDescription,
        incurredOn: new Date().toISOString().slice(0, 10),
        ...(costHours ? { hours: Number(costHours) } : {}),
        ...(costRate ? { hourlyRate: Number(costRate) } : {}),
      }),
    );
    if (res) {
      setCostDescription("");
      setCostHours("");
      onChanged();
    }
  }

  const assessment = opportunity?.assessment;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={opportunity ? `${opportunity.reference} — ${opportunity.title}` : "Pursuit"}
      width={720}
    >
      {loading && !opportunity ? (
        <LoadingBlock rows={3} />
      ) : !opportunity ? null : (
        <div className="space-y-5">
          {action.refusal ? (
            <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
          ) : null}

          <div className="grid gap-4 sm:grid-cols-3">
            <Stat
              label="Value"
              value={
                opportunity.estimatedValue === null
                  ? "—"
                  : money(opportunity.estimatedValue, opportunity.currency)
              }
            />
            <Stat label="Stage" value={titleCase(opportunity.stage)} />
            <Stat
              label="Submission due"
              value={
                opportunity.submissionDueAt ? dateTime(opportunity.submissionDueAt) : "not set"
              }
            />
          </div>

          {/* ---------------------------------------------------- */}
          {/* The gate                                              */}
          {/* ---------------------------------------------------- */}
          <section>
            <h3 className="text-label uppercase text-content-subtle">The bid/no-bid gate</h3>
            {opportunity.bidNoBidDecision === "pending" ? (
              <div className="mt-2 space-y-3">
                <p className="text-meta leading-relaxed text-content-muted">
                  Score the factors that actually matter on this job, then record the decision and
                  its reason. The score suggests; the bid team decides — and a decision that goes
                  against the score is the one worth reading back when the outcome is known.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {FACTORS.map((f) => (
                    <div key={f} className="flex items-center gap-2">
                      <span className="w-40 shrink-0 truncate text-meta text-content-muted">
                        {titleCase(f)}
                      </span>
                      <Input
                        type="number"
                        placeholder="0–10"
                        className="w-20"
                        value={factors[f]?.score ?? ""}
                        onChange={(e) =>
                          setFactors((prev) => ({
                            ...prev,
                            [f]: { score: e.target.value, weight: prev[f]?.weight ?? "10" },
                          }))
                        }
                      />
                      <Input
                        type="number"
                        placeholder="weight"
                        className="w-24"
                        value={factors[f]?.weight ?? ""}
                        onChange={(e) =>
                          setFactors((prev) => ({
                            ...prev,
                            [f]: { score: prev[f]?.score ?? "", weight: e.target.value },
                          }))
                        }
                      />
                    </div>
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Decision" required>
                    <Select value={decision} onChange={(e) => setDecision(e.target.value)}>
                      <option value="bid">Bid</option>
                      <option value="conditional">Bid, conditionally</option>
                      <option value="no_bid">No bid</option>
                    </Select>
                  </Field>
                  <div className="flex items-end">
                    <Button
                      disabled={basis.trim().length < 20}
                      loading={action.busy === "decide"}
                      onClick={() => void decide()}
                    >
                      Record the decision
                    </Button>
                  </div>
                </div>
                <Field
                  label="Why"
                  required
                  hint="At least 20 characters. This is the sentence somebody reads back when the job is won or lost."
                >
                  <Textarea rows={3} value={basis} onChange={(e) => setBasis(e.target.value)} />
                </Field>
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={opportunity.bidNoBidDecision === "no_bid" ? "neutral" : "success"}
                    size="sm"
                  >
                    {titleCase(opportunity.bidNoBidDecision)}
                  </Badge>
                  {opportunity.bidNoBidScore !== null ? (
                    <Badge tone="info" size="xs" variant="subtle">
                      scored {num(opportunity.bidNoBidScore, 0)}/100
                    </Badge>
                  ) : null}
                  <span className="text-2xs text-content-subtle">
                    {dateTime(opportunity.bidNoBidDecidedAt)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-meta leading-relaxed">
                  {opportunity.bidNoBidBasis}
                </p>
                {assessment ? (
                  <>
                    <p className="text-2xs leading-relaxed text-content-subtle">
                      {assessment.basis}
                    </p>
                    {assessment.weightedFactors.length > 0 ? (
                      <Table dense>
                        <thead>
                          <tr>
                            <Th>Factor</Th>
                            <Th align="right">Score</Th>
                            <Th align="right">Weight</Th>
                            <Th align="right">Contribution</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {assessment.weightedFactors.map((f) => (
                            <tr key={f.factor}>
                              <Td>{titleCase(f.factor)}</Td>
                              <Td align="right" className="tabular-nums">
                                {num(f.score, 0)}/10
                              </Td>
                              <Td align="right" className="tabular-nums">
                                {f.sharePercent === null ? "—" : pct(f.sharePercent, 0)}
                              </Td>
                              <Td align="right" className="tabular-nums">
                                {f.contribution === null ? "—" : num(f.contribution, 1)}
                              </Td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    ) : null}
                  </>
                ) : null}
              </div>
            )}
          </section>

          {/* ---------------------------------------------------- */}
          {/* The probability                                       */}
          {/* ---------------------------------------------------- */}
          <section>
            <div className="flex items-center justify-between">
              <h3 className="text-label uppercase text-content-subtle">Win probability</h3>
              <Button
                size="xs"
                variant="secondary"
                loading={action.busy === "probability"}
                onClick={() => void computeProbability()}
              >
                Recompute
              </Button>
            </div>
            {probability ? (
              <ProbabilityPanel result={probability} />
            ) : opportunity.winProbability !== null ? (
              <div className="mt-2">
                <Progress value={opportunity.winProbability * 100} max={100} />
                <p className="mt-1 tabular-nums text-meta">
                  {pct(opportunity.winProbability * 100, 1)} · {opportunity.winProbabilityModel} ·
                  computed {dateTime(opportunity.winProbabilityAt)}
                </p>
                <p className="mt-1 text-2xs leading-relaxed text-content-subtle">
                  {String(
                    (opportunity.winProbabilityBasis as Record<string, unknown>)["basis"] ?? "",
                  )}
                </p>
              </div>
            ) : (
              <Alert tone="info" className="mt-2" icon={IconWarning}>
                <p>
                  No probability is modelled for this pursuit. Recompute to see whether there is
                  enough outcome history yet — where there is not, the answer is the reason rather
                  than a number.
                </p>
              </Alert>
            )}
          </section>

          {/* ---------------------------------------------------- */}
          {/* The outcome                                           */}
          {/* ---------------------------------------------------- */}
          <section>
            <h3 className="text-label uppercase text-content-subtle">Outcome</h3>
            {opportunity.outcome ? (
              <div className="mt-2 space-y-1">
                <Badge tone={opportunity.outcome === "won" ? "success" : "neutral"} size="sm">
                  {titleCase(opportunity.outcome)}
                </Badge>
                <p className="text-meta">{opportunity.outcomeReason ?? ""}</p>
                <p className="text-2xs text-content-subtle">
                  {dateTime(opportunity.outcomeAt)}
                  {opportunity.winningCompetitor ? ` · lost to ${opportunity.winningCompetitor}` : ""}
                  {opportunity.submittedAmount !== null
                    ? ` · we bid ${money(opportunity.submittedAmount, opportunity.currency)}`
                    : ""}
                </p>
              </div>
            ) : (
              <div className="mt-2 space-y-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Outcome">
                    <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                      <option value="won">Won</option>
                      <option value="lost">Lost</option>
                      <option value="no_bid">No bid</option>
                      <option value="abandoned">Abandoned</option>
                    </Select>
                  </Field>
                  <Field label="We submitted">
                    <Input
                      type="number"
                      value={submittedAmount}
                      onChange={(e) => setSubmittedAmount(e.target.value)}
                    />
                  </Field>
                  <Field label="Won by">
                    <Input value={winner} onChange={(e) => setWinner(e.target.value)} />
                  </Field>
                </div>
                <Field label="Reason / debrief">
                  <Textarea
                    rows={2}
                    value={outcomeReason}
                    onChange={(e) => setOutcomeReason(e.target.value)}
                  />
                </Field>
                <Button loading={action.busy === "outcome"} onClick={() => void recordOutcome()}>
                  Record the outcome
                </Button>
              </div>
            )}
          </section>

          {/* ---------------------------------------------------- */}
          {/* Cost of sale                                          */}
          {/* ---------------------------------------------------- */}
          <section>
            <h3 className="text-label uppercase text-content-subtle">What it cost to chase</h3>
            {opportunity.costs && opportunity.costs.byCurrency.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {opportunity.costs.byCurrency.map((c) => (
                  <Badge key={c.currency} tone="neutral" size="sm" variant="subtle">
                    {money(c.total, c.currency)}
                    {c.hours !== null ? ` · ${num(c.hours, 0)} hours` : ""}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-meta text-content-subtle">
                Nothing recorded yet. The hours spent here are real and are spent before any
                revenue exists.
              </p>
            )}
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <Field label="Kind">
                <Select value={costKind} onChange={(e) => setCostKind(e.target.value)}>
                  {[
                    "estimating_labour",
                    "management_labour",
                    "design_fee",
                    "survey",
                    "specialist_advice",
                    "legal",
                    "printing",
                    "travel",
                    "bond_fee",
                    "portal_fee",
                    "other",
                  ].map((k) => (
                    <option key={k} value={k}>
                      {titleCase(k)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Hours">
                <Input
                  type="number"
                  value={costHours}
                  onChange={(e) => setCostHours(e.target.value)}
                />
              </Field>
              <Field label="Rate">
                <Input type="number" value={costRate} onChange={(e) => setCostRate(e.target.value)} />
              </Field>
              <div className="flex items-end">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!costDescription.trim() || (!costHours && !costRate)}
                  loading={action.busy === "cost"}
                  onClick={() => void addCost()}
                >
                  Add
                </Button>
              </div>
            </div>
            <Field label="Description" className="mt-2">
              <Input
                value={costDescription}
                onChange={(e) => setCostDescription(e.target.value)}
              />
            </Field>
          </section>
        </div>
      )}
    </Drawer>
  );
}

function ProbabilityPanel({ result }: { result: WinProbabilityResult }) {
  return (
    <div className="mt-2 space-y-2">
      {result.probability.value === null ? (
        <>
          <p className="italic text-content-subtle">not available</p>
          <ReasonList reasons={result.probability.reasons} tone="info" />
        </>
      ) : (
        <>
          <Progress value={result.probability.value * 100} max={100} />
          <p className="tabular-nums text-meta">{pct(result.probability.value * 100, 1)}</p>
          {result.contributions.length > 0 ? (
            <Table dense>
              <thead>
                <tr>
                  <Th>Feature</Th>
                  <Th align="right">Value</Th>
                  <Th align="right">Weight</Th>
                  <Th align="right">Log-odds</Th>
                </tr>
              </thead>
              <tbody>
                {result.contributions.map((c) => (
                  <tr key={c.feature}>
                    <Td>{titleCase(c.feature)}</Td>
                    <Td align="right" className="tabular-nums">
                      {num(c.value, 3)}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {num(c.weight, 3)}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {num(c.logOdds, 3)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </>
      )}
      <p className="text-2xs leading-relaxed text-content-subtle">{result.basis}</p>
    </div>
  );
}
