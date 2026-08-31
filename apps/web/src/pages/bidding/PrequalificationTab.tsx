/**
 * PREQUALIFICATION — company-level, and it expires.
 *
 * Three controls carry this screen:
 *
 *  - THE KNOCKOUT. A knockout failure fails the submission outright regardless
 *    of score, and the reason NAMES the question. "Failed, 62%" tells the
 *    vendor nothing they can fix and an auditor nothing they can check, so the
 *    named question is what is shown.
 *  - THE UNSCORED CRITERION. A required question the assessor did not score
 *    leaves the overall score NULL with the question named. It is never zero: a
 *    supply-chain approval refused on a question nobody assessed is exactly as
 *    wrong as an award decided that way.
 *  - THE LAPSE. Approvals expire. The register is swept lazily on this read —
 *    never by a cron — and what the sweep did is reported here rather than
 *    happening silently.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  DescriptionList,
  Drawer,
  EmptyState,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Textarea,
} from "../../ui";
import type { DataColumns } from "../../ui";
import { IconCompliance, IconPlus, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  Figure,
  LoadError,
  LoadingBlock,
  PREQUAL_LABEL,
  PREQUAL_TONE,
  ReasonList,
  RecommendedLimitCard,
  RefusalPanel,
  isoDate,
  money,
  num,
  titleCase,
  useAction,
  useNames,
  useResource,
  useVendors,
} from "./biddingShared";
import type {
  Paginated,
  PrequalState,
  PrequalSubmission,
  PrequalSubmissionDetail,
  PrequalSubmissionList,
  Questionnaire,
  QuestionnaireDetail,
} from "./types";

const BASE = "/api/v1/companies/current/prequalification";

const PREQUAL_OUTCOMES = [
  "approved",
  "approved_with_conditions",
  "approved_with_limit",
  "rejected",
] as const;

type View = "register" | "questionnaires";

export default function PrequalificationTab() {
  const [view, setView] = useState<View>("register");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-meta leading-relaxed text-content-muted">
          Prequalification is a property of the supply chain, not of one project — so it lives at
          company level, and it expires. An approval that never expires is a check done once and
          relied on forever.
        </p>
        <SegmentedControl
          aria-label="Prequalification view"
          value={view}
          onChange={setView}
          options={[
            { value: "register", label: "Supply-chain register" },
            { value: "questionnaires", label: "Questionnaires" },
          ]}
        />
      </div>
      {view === "register" ? <RegisterView /> : <QuestionnairesView />}
    </div>
  );
}

/* ================================================================== */
/* The register                                                        */
/* ================================================================== */

function RegisterView() {
  const [version, setVersion] = useState(0);
  const list = useResource<PrequalSubmissionList>(
    `${BASE}/submissions?page=1&pageSize=200&_v=${version}`,
  );
  const questionnaires = useResource<Paginated<Questionnaire>>(
    `${BASE}/questionnaires?page=1&pageSize=200&status=active`,
  );
  const vendors = useVendors();
  const [openId, setOpenId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const vendorName = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of vendors.data?.items ?? []) map.set(v.id, v.name);
    return map;
  }, [vendors.data]);

  function refresh() {
    setVersion((n) => n + 1);
  }

  const rows = list.data?.items ?? [];
  const sweep = list.data?.sweep;

  /**
   * The standing shown on a register row, derived from the row itself.
   *
   * The list endpoint returns raw submissions; the authoritative state (and its
   * sentence) comes from the server on the detail read, and the drawer shows
   * that. This mirrors the same rule — 60 days is the API's renewal window — so
   * a row and its drawer never disagree about whether an approval has lapsed.
   */
  const stateOf = (row: PrequalSubmission): PrequalState => {
    if (row.status === "suspended") return "suspended";
    if (row.outcome === "rejected") return "rejected";
    if (!row.outcome.startsWith("approved")) return "in_progress";
    if (row.status === "expired") return "lapsed";
    if (row.expiresAt) {
      const days = Math.round(
        (Date.parse(`${row.expiresAt}T00:00:00Z`) - Date.now()) / 86_400_000,
      );
      if (days < 0) return "lapsed";
      if (days <= 60) return "expiring";
    }
    return "approved";
  };

  const columns: DataColumns<PrequalSubmission> = useMemo(
    () => [
      {
        id: "reference",
        header: "Ref",
        accessor: "reference",
        type: "code",
        width: 100,
        sticky: "start",
      },
      {
        id: "vendor",
        header: "Vendor",
        accessor: (row) => vendorName.get(row.vendorId) ?? row.vendorId,
        type: "text",
        width: 220,
      },
      {
        id: "state",
        header: "Standing",
        accessor: (row) => stateOf(row),
        type: "text",
        width: 160,
        groupable: true,
        cell: ({ row }) => {
          const state = stateOf(row);
          return (
            <Badge tone={PREQUAL_TONE[state]} size="xs" dot variant="subtle">
              {PREQUAL_LABEL[state]}
            </Badge>
          );
        },
      },
      {
        id: "outcome",
        header: "Outcome",
        accessor: "outcome",
        type: "status",
        width: 190,
        cell: ({ row }) => (
          <div className="min-w-0">
            <Badge
              tone={
                row.outcome === "rejected"
                  ? "danger"
                  : row.outcome === "pending"
                    ? "neutral"
                    : "success"
              }
              size="xs"
              variant="subtle"
            >
              {titleCase(row.outcome)}
            </Badge>
            {row.knockoutFailed ? (
              <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-danger-fg">
                Knockout: {row.knockoutReason}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: "score",
        header: "Score",
        accessor: "scorePercent",
        type: "percent",
        width: 130,
        align: "right",
        cell: ({ row }) =>
          row.scorePercent === null ? (
            <span
              className="text-2xs italic text-content-subtle"
              title="A required question was not scored. An unscored question counted as zero would reject a vendor on evidence nobody looked at."
            >
              not scored
            </span>
          ) : (
            <span className="tabular-nums">{num(row.scorePercent, 1)}%</span>
          ),
      },
      {
        id: "limit",
        header: "Single-project limit",
        accessor: "singleProjectLimit",
        type: "currency",
        width: 180,
        align: "right",
        cell: ({ row }) =>
          row.singleProjectLimit === null ? (
            <span className="text-2xs italic text-content-subtle">uncapped</span>
          ) : (
            <span className="tabular-nums">{money(row.singleProjectLimit, row.currency)}</span>
          ),
      },
      {
        id: "expires",
        header: "Expires",
        accessor: "expiresAt",
        type: "date",
        width: 140,
        cell: ({ row }) => {
          const state = stateOf(row);
          return (
            <span
              className={
                state === "lapsed"
                  ? "font-medium text-danger-fg"
                  : state === "expiring"
                    ? "font-medium text-warning-fg"
                    : undefined
              }
            >
              {isoDate(row.expiresAt)}
            </span>
          );
        },
      },
      {
        id: "obligation",
        header: "Renewal",
        accessor: (row) => (row.obligationId ? "raised" : row.signalId ? "signalled" : "—"),
        width: 130,
        cell: ({ row }) =>
          row.signalId ? (
            <Badge tone="danger" size="xs" variant="subtle">
              signal raised
            </Badge>
          ) : row.obligationId ? (
            <Badge tone="warning" size="xs" variant="subtle">
              obligation open
            </Badge>
          ) : (
            <span className="text-2xs text-content-subtle">—</span>
          ),
      },
    ],
    [vendorName],
  );

  if (list.loading && !list.data) return <LoadingBlock rows={6} />;
  if (list.error) return <LoadError message={list.error} onRetry={list.reload} />;

  const lapsedNow = rows.filter((r) => stateOf(r) === "lapsed").length;
  const expiringNow = rows.filter((r) => stateOf(r) === "expiring").length;

  return (
    <div className="space-y-4">
      {sweep &&
      (sweep.lapsed.length > 0 ||
        sweep.renewalObligationsRaised.length > 0 ||
        sweep.signalsRaised.length > 0 ||
        sweep.notes.length > 0) ? (
        <Alert tone="info" title="What reading this register just settled">
          <p>
            Expiry is swept lazily, on the read — never by a cron. A record nobody reads harms
            nobody; the read is the moment the answer has to be true.
          </p>
          <ul className="mt-1.5 space-y-0.5 text-meta">
            {sweep.lapsed.length > 0 ? (
              <li>{sweep.lapsed.length} approval(s) marked expired.</li>
            ) : null}
            {sweep.renewalObligationsRaised.length > 0 ? (
              <li>
                {sweep.renewalObligationsRaised.length} renewal obligation(s) raised on the
                obligations register.
              </li>
            ) : null}
            {sweep.signalsRaised.length > 0 ? (
              <li>{sweep.signalsRaised.length} lapse signal(s) raised.</li>
            ) : null}
          </ul>
          {sweep.notes.length > 0 ? <ReasonList reasons={sweep.notes} tone="info" className="mt-1.5" /> : null}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Lapsed"
          value={lapsedNow}
          tone={lapsedNow > 0 ? "danger" : "success"}
          hint="An expired approval is not an approval: nothing has been checked about this company since then — not their accounts, not their safety record, not their insurance."
        />
        <StatTile
          label="Inside the renewal window"
          value={expiringNow}
          tone={expiringNow > 0 ? "warning" : "neutral"}
          hint="Renewal is due now. An approval that lapses mid-tender cannot be relied on at award."
        />
        <StatTile
          label="On the register"
          value={list.data?.total ?? rows.length}
          tone="neutral"
          hint="Every questionnaire ever issued to a vendor, decided or not."
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-meta text-content-muted">
          A submission is issued to one vendor against one active questionnaire.
        </p>
        <Button icon={IconPlus} onClick={() => setInviteOpen(true)}>
          Issue a questionnaire
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={IconCompliance}
          title="No vendor has been prequalified"
          hint="Nothing has been asked of anybody. Until a questionnaire is issued and decided, every vendor in the directory stands at 'never prequalified' — which is what an invitation to them will say."
          action={
            <Button icon={IconPlus} onClick={() => setInviteOpen(true)}>
              Issue a questionnaire
            </Button>
          }
        />
      ) : (
        <DataTable<PrequalSubmission>
          tableId="bidding.prequal"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={520}
          rowHeight={56}
          stickyHeader
          filterRow
          searchPlaceholder="Search the supply chain…"
          exportFileName="prequalification-register"
          onRowClick={({ row }) => setOpenId(row.id)}
          rowTone={(row) => {
            const s = stateOf(row);
            return s === "lapsed" || s === "rejected"
              ? "danger"
              : s === "expiring"
                ? "warning"
                : undefined;
          }}
          empty={{ title: "No records match", description: "The filters exclude every record." }}
        />
      )}

      <PrequalDrawer
        submissionId={openId}
        vendorName={vendorName}
        onClose={() => setOpenId(null)}
        onMutated={refresh}
      />

      <IssueModal
        open={inviteOpen}
        questionnaires={(questionnaires.data?.items ?? []).filter((q) => q.status === "active")}
        onClose={() => setInviteOpen(false)}
        onDone={() => {
          setInviteOpen(false);
          refresh();
        }}
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "danger" | "neutral";
  hint: string;
}) {
  return (
    <Card accent={tone}>
      <CardBody>
        <div className="text-label uppercase text-content-subtle">{label}</div>
        <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
        <p className="mt-1 text-2xs leading-snug text-content-subtle">{hint}</p>
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* One prequalification                                                */
/* ================================================================== */

function PrequalDrawer({
  submissionId,
  vendorName,
  onClose,
  onMutated,
}: {
  submissionId: string | null;
  vendorName: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const detail = useResource<PrequalSubmissionDetail>(
    submissionId ? `${BASE}/submissions/${submissionId}` : null,
  );
  const action = useAction();
  const nameOf = useNames();
  const [decideOpen, setDecideOpen] = useState(false);
  const sub = detail.data;

  async function assess() {
    if (!submissionId) return;
    const scores = (sub?.questions ?? [])
      .filter((q) => q.response && q.response.score !== null)
      .map((q) => ({
        questionId: q.id,
        score: q.response!.score,
        maxScore: q.response!.maxScore ?? q.maxScore ?? 100,
      }));
    const done = await action.run("assess", () =>
      api.post(`${BASE}/submissions/${submissionId}/assess`, { scores }),
    );
    if (done) {
      detail.reload();
      onMutated();
    }
  }

  const knockoutFailures = (sub?.questions ?? []).filter(
    (q) => q.isKnockout && q.response?.isKnockoutFail === 1,
  );

  return (
    <>
      <Drawer
        open={submissionId !== null}
        onClose={onClose}
        size="xl"
        title={
          sub
            ? `${sub.reference} — ${vendorName.get(sub.vendorId) ?? sub.vendorId}`
            : "Prequalification"
        }
        description={sub ? sub.questionnaire.name : undefined}
        footer={
          sub ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              {sub.status !== "assessed" ? (
                <Button
                  variant="secondary"
                  loading={action.busy === "assess"}
                  onClick={() => void assess()}
                >
                  Record the assessment
                </Button>
              ) : null}
              {sub.status === "assessed" && !sub.approvedBy ? (
                <Button onClick={() => setDecideOpen(true)}>Decide</Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {detail.loading && !sub ? (
          <LoadingBlock rows={4} />
        ) : detail.error ? (
          <LoadError message={detail.error} onRetry={detail.reload} />
        ) : sub ? (
          <div className="space-y-4">
            <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

            <Alert
              tone={PREQUAL_TONE[sub.standing.state]}
              title={PREQUAL_LABEL[sub.standing.state]}
              icon={sub.standing.state === "lapsed" ? IconWarning : undefined}
            >
              <p>{sub.standing.note}</p>
              {sub.standing.daysToExpiry !== null ? (
                <p className="mt-1 text-meta">
                  {sub.standing.daysToExpiry < 0
                    ? `Expired ${Math.abs(sub.standing.daysToExpiry)} day(s) ago.`
                    : `${sub.standing.daysToExpiry} day(s) to expiry — the renewal window is ${sub.standing.renewalWindowDays} days.`}
                </p>
              ) : null}
            </Alert>

            {sub.knockoutFailed || knockoutFailures.length > 0 ? (
              <Alert tone="danger" title="Knockout failure — the answer that ends the assessment">
                <p>
                  {sub.knockoutReason ??
                    "A knockout question was answered with the disqualifying answer."}
                </p>
                <p className="mt-1 text-meta">
                  A knockout failure is not a low score to be weighed against the rest. This
                  submission cannot be approved, whatever it scored elsewhere.
                </p>
              </Alert>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <Card>
                <CardBody>
                  <div className="text-label uppercase text-content-subtle">Score</div>
                  <div className="mt-0.5 text-xl font-semibold tabular-nums">
                    {sub.assessment ? (
                      <Figure
                        figure={sub.assessment.scorePercent}
                        render={(v) => `${num(v, 1)}%`}
                        showReasons={false}
                      />
                    ) : sub.scorePercent === null ? (
                      <span className="text-base font-normal italic text-content-subtle">
                        not scored
                      </span>
                    ) : (
                      `${num(sub.scorePercent, 1)}%`
                    )}
                  </div>
                  <p className="mt-1 text-2xs text-content-subtle">
                    Pass threshold{" "}
                    {sub.questionnaire.passThreshold === null
                      ? "not declared"
                      : `${num(sub.questionnaire.passThreshold, 0)}%`}
                  </p>
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <div className="text-label uppercase text-content-subtle">
                    Single-project limit
                  </div>
                  <div className="mt-0.5 text-xl font-semibold tabular-nums">
                    {sub.singleProjectLimit === null ? (
                      <span className="text-base font-normal italic text-content-subtle">
                        uncapped
                      </span>
                    ) : (
                      money(sub.singleProjectLimit, sub.currency)
                    )}
                  </div>
                  <p className="mt-1 text-2xs text-content-subtle">
                    {typeof sub.detail["limitBasis"] === "string"
                      ? (sub.detail["limitBasis"] as string)
                      : "No basis recorded for this cap."}
                  </p>
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <div className="text-label uppercase text-content-subtle">Validity</div>
                  <div className="mt-0.5 text-base font-semibold">
                    {isoDate(sub.validFrom)} → {isoDate(sub.expiresAt)}
                  </div>
                  <p className="mt-1 text-2xs text-content-subtle">
                    An approval needs an expiry. A prequalification that never expires is a check
                    done once and relied on forever.
                  </p>
                </CardBody>
              </Card>
            </div>

            {sub.assessment && sub.assessment.unscored.length > 0 ? (
              <Alert tone="warning" title="Not every required question has been scored">
                <p>
                  The overall score is null and stays null. An unscored question counted as zero
                  would reject a vendor on evidence nobody looked at.
                </p>
                <ul className="mt-1.5 space-y-0.5 text-meta">
                  {sub.assessment.unscored.map((u) => (
                    <li key={u.questionId}>{u.label}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            {sub.categoryScores.length > 0 ? (
              <section>
                <h3 className="text-label uppercase text-content-subtle">By category</h3>
                <ul className="mt-2 space-y-1">
                  {sub.categoryScores.map((c) => (
                    <li
                      key={c.category}
                      className="flex items-center justify-between gap-3 rounded-md border border-border p-2 text-meta"
                    >
                      <span>{titleCase(c.category)}</span>
                      <span className="tabular-nums">
                        {c.percent === null ? "—" : `${num(c.percent, 1)}%`}
                        <span className="ml-2 text-2xs text-content-subtle">
                          {num(c.score, 1)} / {num(c.maxScore, 1)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section>
              <h3 className="text-label uppercase text-content-subtle">
                Questions — knockouts marked
              </h3>
              <ul className="mt-2 space-y-2">
                {sub.questions.map((q) => (
                  <li
                    key={q.id}
                    className={
                      q.isKnockout
                        ? "rounded-md border border-danger-border bg-danger-subtle/40 p-2"
                        : "rounded-md border border-border p-2"
                    }
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-meta font-medium">
                          {q.questionCode ? (
                            <code className="mr-1.5 font-mono text-2xs">{q.questionCode}</code>
                          ) : null}
                          {q.text}
                        </p>
                        <p className="mt-0.5 text-2xs text-content-subtle">
                          {titleCase(q.category)} · {titleCase(q.itemType)}
                          {q.required ? " · required" : " · optional"}
                          {q.isKnockout && q.knockoutValue
                            ? ` · disqualifying answer "${q.knockoutValue}"`
                            : ""}
                        </p>
                      </div>
                      {q.isKnockout ? (
                        <Badge tone="danger" size="xs">
                          knockout
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-meta">
                      <span className="text-content-subtle">Answer: </span>
                      {q.response
                        ? (q.response.response ??
                          (q.response.numericValue !== null
                            ? String(q.response.numericValue)
                            : q.response.selectedOptions.join(", ")) ??
                          "—")
                        : "not answered"}
                      {q.response && q.response.score !== null ? (
                        <span className="ml-2 text-2xs text-content-subtle">
                          scored {num(q.response.score, 1)} / {num(q.response.maxScore, 1)}
                        </span>
                      ) : q.required ? (
                        <span className="ml-2 text-2xs italic text-warning-fg">not scored</span>
                      ) : null}
                    </p>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="text-label uppercase text-content-subtle">
                Financial screening on this vendor
              </h3>
              <div className="mt-2">
                <RecommendedLimitCard limit={sub.screening} />
              </div>
            </section>

            <section>
              <h3 className="text-label uppercase text-content-subtle">Control record</h3>
              <DescriptionList
                className="mt-2"
                columns={2}
                size="sm"
                items={[
                  { label: "Issued by", value: nameOf(sub.createdBy) },
                  {
                    label: "Assessed by",
                    value: sub.reviewedBy ? nameOf(sub.reviewedBy) : "not assessed",
                  },
                  {
                    label: "Decided by",
                    value: sub.approvedBy ? nameOf(sub.approvedBy) : "not decided",
                    hint: "Never the person who assessed them, and never the person who issued it.",
                    tone: sub.approvedBy ? "success" : undefined,
                  },
                  {
                    label: "Conditions",
                    value: sub.conditions ?? "none",
                    span: 2,
                  },
                  ...(sub.rejectedReason
                    ? [
                        {
                          label: "Rejected because",
                          value: sub.rejectedReason,
                          span: 2 as const,
                          tone: "danger" as const,
                        },
                      ]
                    : []),
                ]}
              />
            </section>
          </div>
        ) : null}
      </Drawer>

      <DecideModal
        open={decideOpen}
        submission={sub}
        onClose={() => setDecideOpen(false)}
        onDone={() => {
          setDecideOpen(false);
          detail.reload();
          onMutated();
        }}
      />
    </>
  );
}

/* ================================================================== */
/* Decide                                                              */
/* ================================================================== */

function DecideModal({
  open,
  submission,
  onClose,
  onDone,
}: {
  open: boolean;
  submission: PrequalSubmissionDetail | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [outcome, setOutcome] = useState<string>("approved");
  const [conditions, setConditions] = useState("");
  const [rejectedReason, setRejectedReason] = useState("");
  const [limit, setLimit] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  async function submit() {
    if (!submission) return;
    const body: Record<string, unknown> = { outcome };
    if (outcome === "approved_with_conditions") body["conditions"] = conditions.trim();
    if (outcome === "approved_with_limit") body["singleProjectLimit"] = Number(limit);
    if (outcome === "rejected") body["rejectedReason"] = rejectedReason.trim();
    if (expiresAt) body["expiresAt"] = expiresAt;
    const done = await action.run("decide", () =>
      api.post(`${BASE}/submissions/${submission.id}/decide`, body),
    );
    if (done) onDone();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Decide this prequalification"
      description="Admission to the supply chain — never by the person who assessed them."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={action.busy === "decide"}>
            Record the decision
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        {submission?.knockoutFailed ? (
          <Alert tone="danger" title="This submission failed a knockout question">
            It cannot be approved. {submission.knockoutReason}
          </Alert>
        ) : null}
        <Field label="Outcome" required>
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {PREQUAL_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {titleCase(o)}
              </option>
            ))}
          </Select>
        </Field>
        {outcome === "approved_with_conditions" ? (
          <Field label="Conditions" required hint="An approval with conditions must state them.">
            <Textarea rows={3} value={conditions} onChange={(e) => setConditions(e.target.value)} />
          </Field>
        ) : null}
        {outcome === "approved_with_limit" ? (
          <Field
            label={`Single-project limit (${submission?.currency ?? "USD"})`}
            required
            hint="The cap is the whole content of the decision. Leaving it out is refused."
          >
            <Input
              type="number"
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </Field>
        ) : null}
        {outcome === "rejected" ? (
          <Field
            label="Why"
            required
            hint="A rejection must say why — the vendor is entitled to know what to fix."
          >
            <Textarea
              rows={3}
              value={rejectedReason}
              onChange={(e) => setRejectedReason(e.target.value)}
            />
          </Field>
        ) : null}
        {outcome !== "rejected" ? (
          <Field
            label="Expires"
            optional
            hint={
              submission?.questionnaire.validityMonths
                ? `Derived from the questionnaire's ${submission.questionnaire.validityMonths}-month validity if left blank.`
                : "An approval needs an expiry; without a questionnaire validity period one must be given here."
            }
          >
            <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Issue                                                               */
/* ================================================================== */

function IssueModal({
  open,
  questionnaires,
  onClose,
  onDone,
}: {
  open: boolean;
  questionnaires: Questionnaire[];
  onClose: () => void;
  onDone: () => void;
}) {
  const vendors = useVendors();
  const action = useAction();
  const [questionnaireId, setQuestionnaireId] = useState("");
  const [vendorId, setVendorId] = useState("");

  async function submit() {
    const done = await action.run("issue", () =>
      api.post(`${BASE}/submissions`, { questionnaireId, vendorId }),
    );
    if (done) onDone();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Issue a questionnaire"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={action.busy === "issue"}
            disabled={!questionnaireId || !vendorId}
          >
            Issue it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        {questionnaires.length === 0 ? (
          <Alert tone="warning" title="No active questionnaire">
            Only an active, approved questionnaire may be issued to a vendor. Create one and
            activate it first.
          </Alert>
        ) : null}
        <Field label="Questionnaire" required>
          <Select
            value={questionnaireId}
            onChange={(e) => setQuestionnaireId(e.target.value)}
            placeholder="Choose a questionnaire"
          >
            {questionnaires.map((q) => (
              <option key={q.id} value={q.id}>
                {q.reference} — {q.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Vendor" required>
          <Select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            placeholder="Choose a vendor"
          >
            {(vendors.data?.items ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Questionnaires                                                      */
/* ================================================================== */

function QuestionnairesView() {
  const [version, setVersion] = useState(0);
  const list = useResource<Paginated<Questionnaire>>(
    `${BASE}/questionnaires?page=1&pageSize=200&_v=${version}`,
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const rows = list.data?.items ?? [];

  const columns: DataColumns<Questionnaire> = useMemo(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", width: 110, sticky: "start" },
      { id: "name", header: "Questionnaire", accessor: "name", type: "text", width: 300 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        cell: ({ row }) => (
          <Badge
            tone={row.status === "active" ? "success" : row.status === "retired" ? "neutral" : "warning"}
            size="xs"
            dot
            variant="subtle"
          >
            {titleCase(row.status)}
          </Badge>
        ),
      },
      { id: "questions", header: "Questions", accessor: "questionCount", type: "number", width: 110, align: "right" },
      {
        id: "threshold",
        header: "Pass threshold",
        accessor: "passThreshold",
        type: "percent",
        width: 150,
        align: "right",
        cell: ({ row }) =>
          row.passThreshold === null ? (
            <span className="text-2xs text-content-subtle">none declared</span>
          ) : (
            <span className="tabular-nums">{num(row.passThreshold, 0)}%</span>
          ),
      },
      {
        id: "validity",
        header: "Validity",
        accessor: "validityMonths",
        type: "number",
        width: 120,
        align: "right",
        cell: ({ row }) =>
          row.validityMonths === null ? (
            <span className="text-2xs italic text-warning-fg">no expiry derived</span>
          ) : (
            <span className="tabular-nums">{row.validityMonths} months</span>
          ),
      },
    ],
    [],
  );

  if (list.loading && !list.data) return <LoadingBlock rows={4} />;
  if (list.error) return <LoadError message={list.error} onRetry={list.reload} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-meta leading-relaxed text-content-muted">
          A questionnaire cannot be edited once it is active: vendors have been assessed against it,
          and changing the questions would silently change what those assessments mean.
        </p>
        <Button icon={IconPlus} onClick={() => setCreateOpen(true)}>
          New questionnaire
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={IconCompliance}
          title="No questionnaires"
          hint="A questionnaire is the set of questions the supply chain is screened on, with the knockouts that fail a vendor outright and the weights that score the rest. Nothing can be issued until one exists and is active."
          action={
            <Button icon={IconPlus} onClick={() => setCreateOpen(true)}>
              New questionnaire
            </Button>
          }
        />
      ) : (
        <DataTable<Questionnaire>
          tableId="bidding.questionnaires"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={420}
          stickyHeader
          onRowClick={({ row }) => setOpenId(row.id)}
          exportFileName="prequalification-questionnaires"
          empty={{ title: "No questionnaires match", description: "The filters exclude every one." }}
        />
      )}

      <QuestionnaireDrawer questionnaireId={openId} onClose={() => setOpenId(null)} />

      <CreateQuestionnaireModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          setCreateOpen(false);
          setVersion((n) => n + 1);
        }}
      />
    </div>
  );
}

function QuestionnaireDrawer({
  questionnaireId,
  onClose,
}: {
  questionnaireId: string | null;
  onClose: () => void;
}) {
  const detail = useResource<QuestionnaireDetail>(
    questionnaireId ? `${BASE}/questionnaires/${questionnaireId}` : null,
  );
  const q = detail.data;
  return (
    <Drawer
      open={questionnaireId !== null}
      onClose={onClose}
      size="lg"
      title={q ? `${q.reference} — ${q.name}` : "Questionnaire"}
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      {detail.loading && !q ? (
        <LoadingBlock rows={3} />
      ) : detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : q ? (
        <div className="space-y-4">
          <DescriptionList
            columns={2}
            size="sm"
            items={[
              { label: "Status", value: titleCase(q.status) },
              { label: "Version", value: String(q.version) },
              {
                label: "Pass threshold",
                value: q.passThreshold === null ? "none declared" : `${num(q.passThreshold, 0)}%`,
                hint:
                  q.passThreshold === null
                    ? "Without one, no submission can be refused on score alone."
                    : "A submission below this cannot be approved.",
              },
              {
                label: "Validity",
                value: q.validityMonths === null ? "not set" : `${q.validityMonths} months`,
                hint:
                  q.validityMonths === null
                    ? "Every approval will need an explicit expiry date."
                    : "Approvals expire this long after they start.",
              },
              { label: "Questions", value: String(q.questionCount) },
              { label: "Knockouts", value: String(q.knockoutQuestions.length) },
            ]}
          />

          {q.knockoutQuestions.length > 0 ? (
            <Alert tone="danger" variant="subtle" title="The knockout questions">
              <p>
                A wrong answer to any of these fails the submission outright, whatever it scored
                elsewhere — and the reason names the question.
              </p>
              <ul className="mt-1.5 space-y-1 text-meta">
                {q.knockoutQuestions.map((k) => (
                  <li key={k.id}>
                    {k.questionCode ? (
                      <code className="mr-1.5 font-mono text-2xs">{k.questionCode}</code>
                    ) : null}
                    {k.text}
                    {k.knockoutValue ? (
                      <span className="text-content-subtle"> — fails on &ldquo;{k.knockoutValue}&rdquo;</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <section>
            <h3 className="text-label uppercase text-content-subtle">All questions</h3>
            <ul className="mt-2 space-y-1.5">
              {q.questions.map((question) => (
                <li key={question.id} className="rounded-md border border-border p-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-meta">
                      {question.questionCode ? (
                        <code className="mr-1.5 font-mono text-2xs">{question.questionCode}</code>
                      ) : null}
                      {question.text}
                    </p>
                    <div className="flex shrink-0 gap-1">
                      {question.isKnockout ? (
                        <Badge tone="danger" size="xs">
                          knockout
                        </Badge>
                      ) : null}
                      <Badge tone="neutral" size="xs">
                        weight {num(question.weight, 0)}
                      </Badge>
                    </div>
                  </div>
                  <p className="mt-0.5 text-2xs text-content-subtle">
                    {titleCase(question.category)} · {titleCase(question.itemType)}
                    {question.required ? " · required" : " · optional"}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}

function CreateQuestionnaireModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [passThreshold, setPassThreshold] = useState("");
  const [validityMonths, setValidityMonths] = useState("12");

  async function submit() {
    const body: Record<string, unknown> = { name: name.trim() };
    if (description.trim()) body["description"] = description.trim();
    if (passThreshold.trim()) body["passThreshold"] = Number(passThreshold);
    if (validityMonths.trim()) body["validityMonths"] = Number(validityMonths);
    const done = await action.run("create", () => api.post(`${BASE}/questionnaires`, body));
    if (done) onDone();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New questionnaire"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={action.busy === "create"}
            disabled={name.trim().length === 0}
          >
            Create
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        <Field label="Name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Standard subcontractor prequalification 2026"
          />
        </Field>
        <Field label="Description" optional>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Pass threshold (%)"
            optional
            hint="A submission below it cannot be approved. Leave blank rather than invent one."
          >
            <Input
              type="number"
              inputMode="decimal"
              value={passThreshold}
              onChange={(e) => setPassThreshold(e.target.value)}
            />
          </Field>
          <Field
            label="Validity (months)"
            hint="How long an approval lasts before it must be renewed."
          >
            <Input
              type="number"
              inputMode="numeric"
              value={validityMonths}
              onChange={(e) => setValidityMonths(e.target.value)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
