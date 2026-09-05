/**
 * ONE TIMECARD — the hours, the rule that split them, where they are coded,
 * who present them and who approved them.
 *
 * The drawer is ordered by what can go wrong:
 *
 *  1. THE RULE. Which overtime rule produced this split, in the engine's own
 *     words — or the warning that no rule produced it at all.
 *  2. CLAIMED vs PRESENT. Three outcomes, never two. Where no access record
 *     exists it says NOT COMPARABLE and refuses to offer an explanation box,
 *     because there is no variance to explain.
 *  3. THE CODING. Edited here, validated here, and refused by the server with
 *     the difference named if the client-side check is somehow bypassed.
 *  4. THE APPROVAL TRAIL — including the self-approval attempts that were
 *     refused AND written down.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DescriptionList,
  Drawer,
  EmptyState,
  Field,
  Input,
  NumberInput,
  Select,
  Skeleton,
  Table,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Timeline,
  Tooltip,
  Tr,
  type TimelineItem,
} from "../../ui";
import { IconPlus, IconTrash, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  AllocationBalance,
  BUCKET_LABEL,
  EM_DASH,
  HOUR_BUCKETS,
  IDLE_REASON_LABEL,
  LoadError,
  NotComparable,
  PREMIUM_KIND_LABEL,
  RefusalNotice,
  RuleExplanation,
  SectionHeading,
  SelfApprovalAttempts,
  TIMECARD_STATUS_TONE,
  actorName,
  checkDrafts,
  dateTime,
  draftsFrom,
  emptyDraft,
  hoursText,
  isoDate,
  labelize,
  money,
  round2,
  signedHours,
  splitOf,
  useAction,
  type AllocationDraft,
  type Approval,
  type CostCodeOption,
  type Loadable,
  type TimecardDetail,
} from "./timecardsShared";

export default function TimecardDrawer({
  projectId,
  timecardId,
  detail,
  costCodes,
  users,
  onClose,
  onMutated,
}: {
  projectId: string;
  timecardId: string | null;
  detail: Loadable<TimecardDetail>;
  costCodes: CostCodeOption[];
  users: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const card = detail.data;
  const action = useAction();

  return (
    <Drawer
      open={timecardId !== null}
      onClose={onClose}
      side="right"
      size="lg"
      title={
        card ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{card.reference}</span>
            <span className="truncate">{card.workerName ?? card.workerId}</span>
            <Badge tone={TIMECARD_STATUS_TONE[card.status] ?? "neutral"} size="xs" dot>
              {labelize(card.status)}
            </Badge>
          </span>
        ) : (
          "Timecard"
        )
      }
      description={
        card
          ? `${card.workDate} · ${labelize(card.shift)} shift · ${card.crewName ?? "no crew"}${
              card.crewReference ? ` (${card.crewReference})` : ""
            }`
          : undefined
      }
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : detail.loading && !card ? (
        <div className="space-y-3">
          <Skeleton height={90} />
          <Skeleton height={160} />
          <Skeleton height={220} />
        </div>
      ) : !card ? null : (
        <div className="space-y-5">
          {action.refusal ? (
            <RefusalNotice refusal={action.refusal} onDismiss={action.clear} />
          ) : null}

          <SelfApprovalAttempts approvals={card.approvals} users={users} />

          <HoursBlock card={card} />

          <VarianceBlock
            projectId={projectId}
            card={card}
            busy={action.busy}
            onRun={action.run}
            onDone={() => {
              detail.reload();
              onMutated();
            }}
          />

          <AllocationsBlock
            projectId={projectId}
            card={card}
            costCodes={costCodes}
            busy={action.busy}
            onRun={action.run}
            onDone={() => {
              detail.reload();
              onMutated();
            }}
          />

          <ApprovalBlock
            projectId={projectId}
            card={card}
            users={users}
            busy={action.busy}
            onRun={action.run}
            onDone={() => {
              detail.reload();
              onMutated();
            }}
          />
        </div>
      )}
    </Drawer>
  );
}

/* ========================================================================== */
/* Hours and the rule that produced them                                       */
/* ========================================================================== */

function HoursBlock({ card }: { card: TimecardDetail }) {
  const classification = card.detail?.hourClassification;
  return (
    <div>
      <SectionHeading
        title="The hours, and which rule split them"
        hint="A threshold is the FIRST hour at the higher rate: exactly 8.0 worked against an 8-hour threshold is 8 plain and 0 overtime. Half the arguments about a timesheet are about the hour that sits exactly on the line."
      />
      <RuleExplanation classification={classification} configured={card.overtimeRule} />

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {HOUR_BUCKETS.map((bucket) => (
          <div key={bucket} className="rounded-lg border border-border bg-surface-raised p-3">
            <div className="text-2xs uppercase tracking-wide text-content-subtle">
              {BUCKET_LABEL[bucket]}
            </div>
            <div className="mt-0.5 text-display-xs font-semibold tabular-nums text-content">
              {round2(card[bucket]).toFixed(2)}
            </div>
            {bucket === "premiumHours" && card.premiumHours > 0 ? (
              <div className="mt-0.5 text-2xs text-content-muted">
                {PREMIUM_KIND_LABEL[card.premiumKind] ?? labelize(card.premiumKind)}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <DescriptionList
        className="mt-3"
        columns={2}
        size="sm"
        dividers
        items={[
          { label: "Total claimed", value: hoursText(card.totalHours) },
          {
            label: "Clock",
            value:
              card.startTime && card.endTime
                ? `${card.startTime} – ${card.endTime}${
                    card.breakMinutes > 0 ? ` less ${card.breakMinutes} min break` : ""
                  }`
                : EM_DASH,
          },
          {
            label: "Cost",
            value:
              card.totalCost === null ? (
                <Tooltip
                  content={
                    <span className="block max-w-sm space-y-1">
                      {(card.detail?.cost?.reasons ?? [
                        "The platform holds no rate for these hours.",
                      ]).map((reason, index) => (
                        <span key={index} className="block">
                          {reason}
                        </span>
                      ))}
                    </span>
                  }
                >
                  <span className="inline-flex items-center gap-1 text-content-muted">
                    <span className="font-medium">Not available</span>
                    <Badge tone="warning" size="xs">
                      why
                    </Badge>
                  </span>
                </Tooltip>
              ) : (
                money(card.totalCost, card.currency)
              ),
            hint: card.hourlyRate !== null ? `base ${money(card.hourlyRate, card.currency)}/h` : undefined,
          },
          { label: "Classification", value: card.classification ?? EM_DASH },
          {
            label: "Idle",
            value:
              card.idleHours > 0 ? (
                <span>
                  {hoursText(card.idleHours, 1)}{" "}
                  <Badge tone="warning" size="xs" variant="outline">
                    {IDLE_REASON_LABEL[card.idleReason ?? ""] ?? labelize(card.idleReason)}
                  </Badge>
                </span>
              ) : (
                EM_DASH
              ),
            hint: card.idleHours > 0 ? "a memo on hours already claimed, never an addition" : undefined,
          },
          { label: "Source", value: labelize(card.source) },
        ]}
      />
    </div>
  );
}

/* ========================================================================== */
/* Claimed against present                                                     */
/* ========================================================================== */

function VarianceBlock({
  projectId,
  card,
  busy,
  onRun,
  onDone,
}: {
  projectId: string;
  card: TimecardDetail;
  busy: string | null;
  onRun: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
  onDone: () => void;
}) {
  const [explanation, setExplanation] = useState(card.varianceExplanation ?? "");
  useEffect(() => {
    setExplanation(card.varianceExplanation ?? "");
  }, [card.id, card.varianceExplanation]);

  const variance = card.variance;

  return (
    <div>
      <SectionHeading
        title="Claimed against present"
        hint="The turnstile stream is independent evidence; a crew sheet is the claimant's own assertion. The comparison is only meaningful where both exist."
      />

      {variance.value === null ? (
        <Alert tone="neutral" title="Not comparable — and deliberately not a variance">
          <p>{variance.reasons[0] ?? "The platform holds no usable access record for this day."}</p>
          <p className="mt-2 text-meta text-content-muted">
            This card is <strong>not</strong> reported as a variance and never will be while the
            record is missing. A gate log with a hole in it — a broken turnstile, a worker inducted
            at a second entrance, a manual sign-in sheet nobody typed up — would otherwise turn every
            honest card that week into a maximal overclaim, and a control that cries fraud at a data
            gap gets switched off within a month. Then the real overclaims go unseen too.
          </p>
        </Alert>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <Figure label="Claimed" value={hoursText(card.totalHours, 2)} />
            <Figure
              label="Present"
              value={hoursText(variance.accessHours, 2)}
              hint={
                variance.accessHoursSource === "derived_from_gate_times"
                  ? "derived from the in/out pair"
                  : "as recorded by the access stream"
              }
            />
            <Figure
              label="Variance"
              value={signedHours(variance.value)}
              tone={
                variance.withinTolerance
                  ? "neutral"
                  : variance.value > 0
                    ? "danger"
                    : "info"
              }
              hint={`tolerance ±${variance.toleranceHours} h`}
            />
          </div>

          {card.siteAccess ? (
            <p className="text-2xs text-content-subtle">
              Access record {card.siteAccess.id} · {card.siteAccess.source} ·{" "}
              {card.siteAccess.firstIn ?? "?"} to {card.siteAccess.lastOut ?? "?"} on{" "}
              {card.siteAccess.accessDate}
            </p>
          ) : null}

          {variance.requiresExplanation ? (
            <Alert tone="danger" icon={IconWarning} title="This variance is owed an explanation">
              {signedHours(variance.value)} beyond the ±{variance.toleranceHours} h tolerance, and
              nothing on the record says why. An unexplained positive variance repeated across days
              is what raises an overclaim signal — one explained day does not.
            </Alert>
          ) : variance.explained ? (
            <Alert tone="success" size="sm" title="Explained">
              {card.varianceExplanation}
            </Alert>
          ) : null}

          {card.isEditable ? (
            <div className="space-y-2">
              <Textarea
                rows={2}
                value={explanation}
                onChange={(event) => setExplanation(event.target.value)}
                placeholder="Why do the claimed hours differ from the hours recorded at the gate? The explanation travels with the record."
                aria-label="Variance explanation"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={!explanation.trim() || explanation.trim() === (card.varianceExplanation ?? "")}
                loading={busy === "explain"}
                onClick={async () => {
                  const result = await onRun("explain", () =>
                    api.post(
                      `/api/v1/projects/${projectId}/timecards/${card.id}/explain-variance`,
                      { varianceExplanation: explanation.trim() },
                    ),
                  );
                  if (result) onDone();
                }}
              >
                Record the explanation
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "danger" | "info";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-3">
      <div className="text-2xs uppercase tracking-wide text-content-subtle">{label}</div>
      <div
        className={
          tone === "danger"
            ? "mt-0.5 text-display-xs font-semibold tabular-nums text-danger-fg"
            : tone === "info"
              ? "mt-0.5 text-display-xs font-semibold tabular-nums text-info-fg"
              : "mt-0.5 text-display-xs font-semibold tabular-nums text-content"
        }
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-2xs text-content-subtle">{hint}</div> : null}
    </div>
  );
}

/* ========================================================================== */
/* Allocations                                                                 */
/* ========================================================================== */

function AllocationsBlock({
  projectId,
  card,
  costCodes,
  busy,
  onRun,
  onDone,
}: {
  projectId: string;
  card: TimecardDetail;
  costCodes: CostCodeOption[];
  busy: string | null;
  onRun: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<AllocationDraft[]>(() => draftsFrom(card.allocations));

  useEffect(() => {
    setDrafts(draftsFrom(card.allocations));
    setEditing(false);
  }, [card.id, card.allocations]);

  const claimed = useMemo(() => splitOf(card), [card]);
  const check = useMemo(() => checkDrafts(claimed, drafts), [claimed, drafts]);
  const nameless = drafts.some((draft) => !draft.costCodeId && !draft.costCode);
  const empty = drafts.some(
    (draft) =>
      round2(
        draft.regularHours + draft.overtimeHours + draft.doubleTimeHours + draft.premiumHours,
      ) <= 0,
  );

  function update(key: string, patch: Partial<AllocationDraft>) {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    );
  }

  /** Put every unallocated hour on the first line — the common case. */
  function balanceOnto(key: string) {
    setDrafts((current) => {
      const others = current.filter((draft) => draft.key !== key);
      const sums = {
        regularHours: 0,
        overtimeHours: 0,
        doubleTimeHours: 0,
        premiumHours: 0,
      };
      for (const draft of others) {
        for (const bucket of HOUR_BUCKETS) sums[bucket] += draft[bucket] || 0;
      }
      return current.map((draft) =>
        draft.key === key
          ? {
              ...draft,
              regularHours: Math.max(0, round2(claimed.regularHours - sums.regularHours)),
              overtimeHours: Math.max(0, round2(claimed.overtimeHours - sums.overtimeHours)),
              doubleTimeHours: Math.max(0, round2(claimed.doubleTimeHours - sums.doubleTimeHours)),
              premiumHours: Math.max(0, round2(claimed.premiumHours - sums.premiumHours)),
            }
          : draft,
      );
    });
  }

  return (
    <div>
      <SectionHeading
        title="Cost coding"
        hint="This is the join that puts labour on the cost report. An allocation set that does not add up is either hours nobody can code or hours coded twice, and both arrive on the cost report looking like fact."
        actions={
          card.isEditable && card.status !== "approved" ? (
            editing ? (
              <span className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDrafts(draftsFrom(card.allocations));
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!check.ok || nameless || empty || drafts.length === 0}
                  loading={busy === "allocations"}
                  onClick={async () => {
                    const result = await onRun("allocations", () =>
                      api.put(
                        `/api/v1/projects/${projectId}/timecards/${card.id}/allocations`,
                        {
                          allocations: drafts.map((draft) => ({
                            ...(draft.costCodeId ? { costCodeId: draft.costCodeId } : {}),
                            ...(draft.costCode ? { costCode: draft.costCode } : {}),
                            costType: draft.costType,
                            regularHours: draft.regularHours,
                            overtimeHours: draft.overtimeHours,
                            doubleTimeHours: draft.doubleTimeHours,
                            premiumHours: draft.premiumHours,
                            ...(draft.notes ? { notes: draft.notes } : {}),
                          })),
                        },
                      ),
                    );
                    if (result) {
                      setEditing(false);
                      onDone();
                    }
                  }}
                >
                  Save the coding
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                {card.allocations.length === 0 ? "Code these hours" : "Re-code"}
              </Button>
            )
          ) : null
        }
      />

      <AllocationBalance
        check={editing ? check : card.allocationCheck}
        emptyMessage={
          !editing && card.allocations.length === 0
            ? (card.allocationCheck.message ??
              "This card has no cost coding at all. Hours nobody can code are how a labour overrun stays invisible until the month-end journal.")
            : null
        }
        className="mb-3"
      />

      {editing ? (
        <div className="space-y-2">
          {drafts.map((draft) => (
            <Card key={draft.key}>
              <CardBody className="space-y-2">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex min-w-[220px] flex-1 flex-col gap-1">
                    <span className="text-2xs uppercase tracking-wide text-content-subtle">
                      Cost code
                    </span>
                    <Select
                      size="sm"
                      value={draft.costCodeId ?? ""}
                      onChange={(event) => {
                        const id = event.target.value;
                        const option = costCodes.find((code) => code.id === id);
                        update(draft.key, {
                          costCodeId: id || null,
                          costCode: option?.code ?? null,
                        });
                      }}
                      aria-label="Cost code"
                    >
                      <option value="">Choose a cost code…</option>
                      {costCodes.map((code) => (
                        <option key={code.id} value={code.id}>
                          {code.code} · {code.title}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="flex w-40 flex-col gap-1">
                    <span className="text-2xs uppercase tracking-wide text-content-subtle">
                      Or a free code
                    </span>
                    <Input
                      size="sm"
                      value={draft.costCode ?? ""}
                      onChange={(event) =>
                        update(draft.key, { costCode: event.target.value || null })
                      }
                      placeholder="e.g. 03-3000"
                      aria-label="Free-text cost code"
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={IconTrash}
                    aria-label="Remove this allocation"
                    onClick={() =>
                      setDrafts((current) => current.filter((entry) => entry.key !== draft.key))
                    }
                  >
                    Remove
                  </Button>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  {HOUR_BUCKETS.map((bucket) => (
                    <label key={bucket} className="flex w-32 flex-col gap-1">
                      <span className="text-2xs uppercase tracking-wide text-content-subtle">
                        {BUCKET_LABEL[bucket]}
                      </span>
                      <NumberInput
                        size="sm"
                        value={draft[bucket]}
                        min={0}
                        max={24}
                        step={0.25}
                        precision={2}
                        onChange={(value) => update(draft.key, { [bucket]: value ?? 0 })}
                        aria-label={`${BUCKET_LABEL[bucket]} hours`}
                      />
                    </label>
                  ))}
                  <Button size="sm" variant="ghost" onClick={() => balanceOnto(draft.key)}>
                    Balance onto this line
                  </Button>
                </div>
              </CardBody>
            </Card>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={IconPlus}
              onClick={() => setDrafts((current) => [...current, emptyDraft(current.length)])}
            >
              Add a coding line
            </Button>
            {nameless ? (
              <span className="text-meta text-danger-fg">
                Every line must name a cost code. Hours that land nowhere are exactly the hours that
                never reach the cost report.
              </span>
            ) : null}
            {empty ? (
              <span className="text-meta text-danger-fg">
                A line with no hours codes nothing and only clutters the cost report.
              </span>
            ) : null}
          </div>
        </div>
      ) : card.allocations.length === 0 ? (
        <EmptyState
          size="sm"
          tone="danger"
          title="These hours are coded nowhere"
          hint="A timecard with no allocation cannot be submitted, and until it is coded these hours appear on no cost report. The overrun they cause will surface at month end with nothing to attribute it to."
        />
      ) : (
        <Table dense tableClassName="min-w-[620px] text-meta">
            <THead>
              <Tr>
                <Th>Cost code</Th>
                <Th align="right">Plain</Th>
                <Th align="right">OT</Th>
                <Th align="right">DT</Th>
                <Th align="right">Premium</Th>
                <Th align="right">Cost</Th>
                <Th>Budget line</Th>
              </Tr>
            </THead>
            <TBody>
              {card.allocations.map((allocation) => (
                <Tr key={allocation.id}>
                  <Td>
                    <span className="font-mono text-content">
                      {allocation.costCode ?? allocation.costCodeId ?? EM_DASH}
                    </span>
                    {allocation.notes ? (
                      <div className="text-2xs text-content-subtle">{allocation.notes}</div>
                    ) : null}
                  </Td>
                  <Td align="right" numeric>
                    {allocation.regularHours}
                  </Td>
                  <Td align="right" numeric>
                    {allocation.overtimeHours}
                  </Td>
                  <Td align="right" numeric>
                    {allocation.doubleTimeHours}
                  </Td>
                  <Td align="right" numeric>
                    {allocation.premiumHours}
                  </Td>
                  <Td align="right" numeric>
                    {allocation.cost === null ? (
                      <Tooltip content="These hours carry no rate the platform can price, so this line's cost is unknown rather than zero.">
                        <span className="text-content-muted">no rate</span>
                      </Tooltip>
                    ) : (
                      money(allocation.cost, allocation.currency)
                    )}
                  </Td>
                  <Td>
                    {allocation.budgetLineItemId ? (
                      <Badge tone="success" size="xs" variant="outline">
                        on budget
                      </Badge>
                    ) : (
                      <Tooltip content="This line names a cost code but no budget line. It is visible in a labour report and does not land on the budget.">
                        <span>
                          <Badge tone="warning" size="xs">
                            off budget
                          </Badge>
                        </span>
                      </Tooltip>
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
      )}
    </div>
  );
}

/* ========================================================================== */
/* Approvals                                                                   */
/* ========================================================================== */

function ApprovalBlock({
  projectId,
  card,
  users,
  busy,
  onRun,
  onDone,
}: {
  projectId: string;
  card: TimecardDetail;
  users: Map<string, string>;
  busy: string | null;
  onRun: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
  onDone: () => void;
}) {
  const [comment, setComment] = useState("");

  const items = useMemo<TimelineItem[]>(
    () =>
      card.approvals.map((approval: Approval) => ({
        id: approval.id,
        title:
          approval.isSelfApproval === 1
            ? `Self-approval refused at level ${approval.level}`
            : `${labelize(approval.decision)} at level ${approval.level}`,
        timestamp: approval.decidedAt,
        actor: actorName(users, approval.approverId),
        tone:
          approval.isSelfApproval === 1
            ? "danger"
            : approval.decision === "approved"
              ? "success"
              : approval.decision === "rejected"
                ? "danger"
                : "info",
        badge:
          approval.isSelfApproval === 1 ? (
            <Badge tone="danger" size="xs" variant="solid">
              recorded &amp; refused
            </Badge>
          ) : approval.approverRole ? (
            <Badge tone="neutral" size="xs" variant="outline">
              {approval.approverRole}
            </Badge>
          ) : undefined,
        description: approval.comment ?? undefined,
        body:
          approval.isSelfApproval === 1 ? (
            <p className="text-meta text-content-muted">
              The attempt was written before it was refused —{" "}
              <span className="font-mono text-2xs">isSelfApproval</span> set on this row, a signal
              raised, and a ledger entry appended. Breached relationship:{" "}
              {approval.detail?.breachedRelationship === "submitted_by"
                ? "they submitted this card"
                : "they raised this card"}
              .
            </p>
          ) : undefined,
      })),
    [card.approvals, users],
  );

  const canSubmit = card.status === "draft" || card.status === "rejected";
  const canApprove = card.status === "submitted";
  /** The API allows an adjustment only against a card that is already fixed —
   *  and only once, so a chain stays readable where a fan would not. */
  const canRevise =
    ["approved", "locked", "exported"].includes(card.status) && !card.detail?.revisedBy;
  const [adjustHours, setAdjustHours] = useState<number | null>(card.totalHours);
  const [adjustDate, setAdjustDate] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  return (
    <div>
      <SectionHeading
        title="Approval"
        hint="A control that silently blocks a breach leaves no evidence the breach was attempted. Here the attempt is written first and refused second."
      />

      <DescriptionList
        columns={2}
        size="sm"
        dividers
        className="mb-3"
        items={[
          {
            label: "Submitted by",
            value: actorName(users, card.submittedBy),
            hint: card.submittedAt ? dateTime(card.submittedAt) : "not submitted",
          },
          {
            label: "Approved by",
            value: actorName(users, card.approvedBy),
            hint: card.approvedAt ? dateTime(card.approvedAt) : "not approved",
          },
          { label: "Raised by", value: actorName(users, card.createdBy) },
          {
            label: "Frozen",
            value: card.lockedAt
              ? `Locked ${dateTime(card.lockedAt)}`
              : card.exportedAt
                ? `Exported ${dateTime(card.exportedAt)}`
                : "No",
            hint: card.isEditable
              ? undefined
              : "After a lock or export a correction is a new dated adjustment, never an edit.",
          },
        ]}
      />

      {card.rejectedReason ? (
        <Alert tone="danger" size="sm" title="Returned" className="mb-3">
          {card.rejectedReason}
        </Alert>
      ) : null}

      {canSubmit || canApprove ? (
        <Card className="mb-3">
          <CardBody className="space-y-2">
            <Textarea
              rows={2}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={
                canApprove
                  ? "Comment on the approval — it travels with the record."
                  : "Comment for whoever approves this."
              }
              aria-label="Approval comment"
            />
            <div className="flex flex-wrap items-center gap-2">
              {canSubmit ? (
                <Button
                  size="sm"
                  loading={busy === "submit"}
                  disabled={card.allocations.length === 0 || !card.allocationCheck.ok}
                  onClick={async () => {
                    const result = await onRun("submit", () =>
                      api.post(`/api/v1/projects/${projectId}/timecards/${card.id}/submit`, {
                        comment: comment.trim() || null,
                      }),
                    );
                    if (result) {
                      setComment("");
                      onDone();
                    }
                  }}
                >
                  Submit for approval
                </Button>
              ) : null}
              {canApprove ? (
                <>
                  <Button
                    size="sm"
                    loading={busy === "approve"}
                    onClick={async () => {
                      const result = await onRun("approve", () =>
                        api.post(`/api/v1/projects/${projectId}/timecards/${card.id}/approve`, {
                          decision: "approved",
                          comment: comment.trim() || null,
                        }),
                      );
                      if (result) {
                        setComment("");
                        onDone();
                      }
                    }}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === "return"}
                    disabled={!comment.trim()}
                    onClick={async () => {
                      const result = await onRun("return", () =>
                        api.post(`/api/v1/projects/${projectId}/timecards/${card.id}/approve`, {
                          decision: "returned_for_revision",
                          comment: comment.trim(),
                        }),
                      );
                      if (result) {
                        setComment("");
                        onDone();
                      }
                    }}
                  >
                    Return for revision
                  </Button>
                </>
              ) : null}
            </div>
            {canSubmit && card.allocations.length === 0 ? (
              <p className="text-meta text-danger-fg">
                This card cannot be submitted until its hours are coded. A timecard with no
                allocation is hours nobody can code.
              </p>
            ) : null}
            {canApprove ? (
              <p className="text-2xs text-content-muted">
                If you submitted or raised this card, approving it will be refused — and the attempt
                will be recorded as an approval row with{" "}
                <span className="font-mono">isSelfApproval</span> set, a signal, and a ledger entry.
                That is the control working, not a bug.
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          size="sm"
          title="Nothing has been decided on this card yet"
          hint={
            card.status === "draft"
              ? "It is still a draft. The approval trail begins when somebody submits it — and every act on it, including a refused self-approval, is written here."
              : "No approval act has been recorded against this card."
          }
        />
      ) : (
        <Timeline items={items} timeFormat="absolute" aria-label="Approval trail" />
      )}

      {canRevise ? (
        <Card className="mt-3">
          <CardBody className="space-y-2">
            <SectionHeading
              title="Correct it"
              hint="An approved, locked or exported card is never edited. The correction is a NEW dated card that references this one, so what was paid and what should have been paid both stay readable."
            />
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Corrected total hours" required>
                <NumberInput
                  value={adjustHours}
                  onChange={setAdjustHours}
                  min={0}
                  max={24}
                  step={0.25}
                />
              </Field>
              <Field label="Adjustment date" hint="Not before the day being corrected">
                <Input
                  type="date"
                  value={adjustDate}
                  onChange={(event) => setAdjustDate(event.target.value)}
                />
              </Field>
              <Field label="Reason" required>
                <Input
                  value={adjustReason}
                  onChange={(event) => setAdjustReason(event.target.value)}
                  placeholder="Two hours omitted from Tuesday"
                />
              </Field>
            </div>
            <Button
              size="sm"
              loading={busy === "revise"}
              disabled={adjustHours === null || !adjustReason.trim()}
              onClick={async () => {
                const result = await onRun("revise", () =>
                  api.post(`/api/v1/projects/${projectId}/timecards/${card.id}/revise`, {
                    workedHours: adjustHours,
                    adjustmentDate: adjustDate || undefined,
                    reason: adjustReason.trim(),
                  }),
                );
                if (result) {
                  setAdjustReason("");
                  onDone();
                }
              }}
            >
              Raise the adjustment
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {card.revisesTimecardId ? (
        <Alert tone="info" size="sm" title="This card is a dated adjustment" className="mt-3">
          It corrects timecard {card.revisesTimecardId}. The original stays exactly as it was paid —
          the platform holds one card per worker, day and shift, and that uniqueness is what makes
          &ldquo;how many hours did this person claim on Tuesday&rdquo; answerable at all.
        </Alert>
      ) : null}
      {card.detail?.revisedBy ? (
        <Alert tone="warning" size="sm" title="This card has been superseded" className="mt-3">
          A later adjustment ({card.detail.revisedBy.reference ?? "another card"}) corrects it. Both
          figures stay readable next to each other; neither is deleted.
        </Alert>
      ) : null}
      {!card.isEditable && !card.lockedAt && !card.exportedAt ? (
        <p className="mt-3 text-2xs text-content-subtle">
          Frozen at status {labelize(card.status)} — {isoDate(card.updatedAt)}.
        </p>
      ) : null}
      {card.siteAccess === null && card.variance.value === null ? (
        <p className="mt-3 text-2xs text-content-subtle">
          <NotComparable
            reason="No access record backs this card, so no claimed-vs-present comparison exists for it. It is neither confirmed nor contradicted."
            label="No presence evidence"
          />
        </p>
      ) : null}
    </div>
  );
}
