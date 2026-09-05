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
import { useEffect, useMemo, useState } from "react";
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
import { IconCheck, IconCompliance, IconPlus, IconSave, IconTrash, IconWarning } from "../../ui/icons";
import { CHECKLIST_ITEM_TYPES, PREQUAL_CATEGORIES } from "@constructos/shared";
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
  QuestionnaireQuestion,
  QuestionnaireDetail,
} from "./types";

import {
  LicenceRegisterView,
  TierCard,
  VendorEvidencePanel,
  VendorPortalPanel,
} from "./PrequalEvidence";

const BASE = "/api/v1/companies/current/prequalification";

const PREQUAL_OUTCOMES = [
  "approved",
  "approved_with_conditions",
  "approved_with_limit",
  "rejected",
] as const;

type View = "register" | "questionnaires" | "licences";

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
            { value: "licences", label: "Licence expiry" },
          ]}
        />
      </div>
      {view === "register" ? (
        <RegisterView />
      ) : view === "questionnaires" ? (
        <QuestionnairesView />
      ) : (
        <LicenceRegisterView />
      )}
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

/** Answers a bidder can give, keyed the way the shared validator expects. */
interface AnswerDraft {
  response: string;
  numericValue: string;
  selectedOptions: string[];
}

const BOOLEAN_ITEM_OPTIONS: Record<string, readonly string[]> = {
  yes_no: ["yes", "no"],
  pass_fail: ["pass", "fail"],
  pass_fail_na: ["pass", "fail", "na"],
};

const NUMERIC_ITEM_TYPES = new Set(["numeric", "measurement", "instrument_reading", "temperature"]);
const STRUCTURAL_ITEM_TYPES = new Set(["section_header"]);

/** Statuses at which the register still accepts answers (the API refuses the rest). */
const ANSWERABLE_STATUSES = new Set([
  "invited",
  "in_progress",
  "submitted",
  "under_review",
  "clarification_requested",
]);

function optionsFor(q: QuestionnaireQuestion): readonly string[] {
  const declared = BOOLEAN_ITEM_OPTIONS[q.itemType];
  if (declared && q.options.length === 0) return declared;
  return q.options;
}

function draftFrom(q: QuestionnaireQuestion): AnswerDraft {
  const r = q.response ?? null;
  return {
    response: r?.response ?? "",
    numericValue: r?.numericValue === null || r?.numericValue === undefined ? "" : String(r.numericValue),
    selectedOptions: r?.selectedOptions ?? [],
  };
}

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

  /*
   * THE ANSWERS AND THE SCORES ARE HELD SEPARATELY, AND SO ARE THE PEOPLE.
   *
   * The drawer previously had no way to record either: "Record the assessment"
   * re-sent whatever scores were already on the responses, which on a fresh
   * submission was nothing at all — so the first click produced an assessment
   * with every required question unscored and a null overall score, and the
   * decision that followed was refused. Answers are captured here, scores are
   * captured here, and neither is invented from the other.
   */
  const [answers, setAnswers] = useState<Record<string, AnswerDraft>>({});
  const [scores, setScores] = useState<Record<string, string>>({});
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const questions = useMemo(() => sub?.questions ?? [], [sub]);

  useEffect(() => {
    if (!sub) return;
    const stamp = `${sub.id}:${sub.updatedAt ?? ""}:${sub.status}`;
    if (loadedFor === stamp) return;
    const nextAnswers: Record<string, AnswerDraft> = {};
    const nextScores: Record<string, string> = {};
    for (const q of sub.questions) {
      nextAnswers[q.id] = draftFrom(q);
      const s = q.response?.score;
      nextScores[q.id] = s === null || s === undefined ? "" : String(s);
    }
    setAnswers(nextAnswers);
    setScores(nextScores);
    setLoadedFor(stamp);
  }, [sub, loadedFor]);

  function setAnswer(questionId: string, patch: Partial<AnswerDraft>) {
    setAnswers((prev) => ({
      ...prev,
      [questionId]: { ...(prev[questionId] ?? { response: "", numericValue: "", selectedOptions: [] }), ...patch },
    }));
  }

  /** Only questions the user actually touched or that already carry an answer. */
  function answerPayload(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const q of questions) {
      if (STRUCTURAL_ITEM_TYPES.has(q.itemType)) continue;
      const draft = answers[q.id];
      if (!draft) continue;
      const hasText = draft.response.trim().length > 0;
      const hasNumber = draft.numericValue.trim().length > 0;
      const hasOptions = draft.selectedOptions.length > 0;
      if (!hasText && !hasNumber && !hasOptions) continue;
      out.push({
        questionId: q.id,
        response: hasText ? draft.response.trim() : null,
        numericValue: hasNumber ? Number(draft.numericValue) : null,
        selectedOptions: draft.selectedOptions,
        fileIds: q.response?.fileIds ?? [],
      });
    }
    return out;
  }

  async function saveAnswers(): Promise<boolean> {
    if (!submissionId) return false;
    const responses = answerPayload();
    if (responses.length === 0) return true;
    const done = await action.run("answers", () =>
      api.post(`${BASE}/submissions/${submissionId}/responses`, { responses }),
    );
    if (done) {
      setLoadedFor(null);
      detail.reload();
      onMutated();
    }
    return done !== null;
  }

  async function submitResponses() {
    if (!submissionId) return;
    const saved = await saveAnswers();
    if (!saved) return;
    const done = await action.run("submit", () =>
      api.post(`${BASE}/submissions/${submissionId}/submit`, {}),
    );
    if (done) {
      setLoadedFor(null);
      detail.reload();
      onMutated();
    }
  }

  async function assess() {
    if (!submissionId) return;
    const payload = questions
      .filter((q) => !STRUCTURAL_ITEM_TYPES.has(q.itemType))
      .map((q) => {
        const raw = scores[q.id] ?? "";
        return {
          questionId: q.id,
          score: raw.trim() === "" ? null : Number(raw),
          maxScore: q.maxScore ?? q.response?.maxScore ?? null,
        };
      })
      .filter((s) => s.score !== null || s.maxScore !== null);
    const done = await action.run("assess", () =>
      api.post(`${BASE}/submissions/${submissionId}/assess`, { scores: payload }),
    );
    if (done) {
      setLoadedFor(null);
      detail.reload();
      onMutated();
    }
  }

  const knockoutFailures = questions.filter((q) => q.isKnockout && q.response?.isKnockoutFail === 1);
  const status = sub?.status ?? "";
  const answerable = ANSWERABLE_STATUSES.has(status);
  const scoreable = sub !== null && !["invited", "in_progress"].includes(status) && !sub.approvedBy;
  const unanswered = questions.filter(
    (q) => q.required && !STRUCTURAL_ITEM_TYPES.has(q.itemType) && !q.response,
  );
  const unscored = questions.filter(
    (q) =>
      q.required &&
      !STRUCTURAL_ITEM_TYPES.has(q.itemType) &&
      (q.maxScore ?? 0) > 0 &&
      (scores[q.id] ?? "").trim() === "",
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
              {answerable ? (
                <Button
                  variant="secondary"
                  icon={IconSave}
                  loading={action.busy === "answers"}
                  onClick={() => void saveAnswers()}
                >
                  Save answers
                </Button>
              ) : null}
              {status === "invited" || status === "in_progress" ? (
                <Button
                  variant="secondary"
                  loading={action.busy === "submit"}
                  onClick={() => void submitResponses()}
                >
                  Submit the questionnaire
                </Button>
              ) : null}
              {scoreable ? (
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

            {answerable && unanswered.length > 0 ? (
              <Alert tone="info" variant="subtle" title={`${unanswered.length} required question(s) unanswered`}>
                <p>
                  The questionnaire cannot be submitted until every required question carries an
                  answer. Answers are saved as they stand; submitting is a separate, recorded step.
                </p>
              </Alert>
            ) : null}

            {scoreable && unscored.length > 0 ? (
              <Alert tone="warning" variant="subtle" title={`${unscored.length} scorable question(s) not yet scored`}>
                <p>
                  A required question left blank leaves the overall score null — never zero. Score
                  them, or record the assessment and let the null stand with the questions named.
                </p>
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
              <p className="mt-1 text-2xs text-content-subtle">
                {answerable
                  ? "Answers are recorded here and validated against the question's declared type; evidence is required where the question says so."
                  : "This submission no longer takes answers — what is shown is what was recorded."}
                {scoreable
                  ? " Scores are the assessor's, kept apart from the answers, and a blank stays blank."
                  : ""}
              </p>
              <ul className="mt-2 space-y-2">
                {questions.map((q) => (
                  <QuestionRow
                    key={q.id}
                    question={q}
                    draft={answers[q.id] ?? { response: "", numericValue: "", selectedOptions: [] }}
                    score={scores[q.id] ?? ""}
                    answerable={answerable}
                    scoreable={scoreable}
                    onAnswer={(patch) => setAnswer(q.id, patch)}
                    onScore={(value) => setScores((prev) => ({ ...prev, [q.id]: value }))}
                  />
                ))}
              </ul>
            </section>

            <section>
              <h3 className="text-label uppercase text-content-subtle">
                Tier — what size of package this vendor may be considered for
              </h3>
              <div className="mt-2">
                <TierCard tier={sub.tier} />
              </div>
            </section>

            <section>
              <h3 className="text-label uppercase text-content-subtle">
                The evidence the tier is computed from
              </h3>
              <div className="mt-2">
                <VendorEvidencePanel
                  vendorId={sub.vendorId}
                  submissionId={sub.id}
                  onMutated={() => {
                    setLoadedFor(null);
                    detail.reload();
                    onMutated();
                  }}
                />
              </div>
            </section>

            <VendorPortalPanel
              submissionId={sub.id}
              portal={sub.vendorPortal}
              onMutated={() => {
                setLoadedFor(null);
                detail.reload();
              }}
            />

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
          setLoadedFor(null);
          detail.reload();
          onMutated();
        }}
      />
    </>
  );
}

/** One question: what was asked, what was answered, and what it scored. */
function QuestionRow({
  question,
  draft,
  score,
  answerable,
  scoreable,
  onAnswer,
  onScore,
}: {
  question: QuestionnaireQuestion;
  draft: AnswerDraft;
  score: string;
  answerable: boolean;
  scoreable: boolean;
  onAnswer: (patch: Partial<AnswerDraft>) => void;
  onScore: (value: string) => void;
}) {
  const q = question;
  const options = optionsFor(q);
  const structural = STRUCTURAL_ITEM_TYPES.has(q.itemType);
  const numeric = NUMERIC_ITEM_TYPES.has(q.itemType);
  const recorded = q.response;

  return (
    <li
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
            {q.isKnockout && q.knockoutValue ? ` · disqualifying answer "${q.knockoutValue}"` : ""}
            {q.evidenceRequired ? " · evidence required" : ""}
          </p>
          {q.guidance ? (
            <p className="mt-0.5 text-2xs italic text-content-subtle">{q.guidance}</p>
          ) : null}
        </div>
        {q.isKnockout ? (
          <Badge tone="danger" size="xs">
            knockout
          </Badge>
        ) : null}
      </div>

      {structural ? null : answerable ? (
        <div className="mt-1.5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="min-w-0">
            {options.length > 0 ? (
              <Select
                aria-label={`Answer to ${q.questionCode ?? q.text}`}
                value={draft.selectedOptions[0] ?? ""}
                onChange={(e) =>
                  onAnswer({ selectedOptions: e.target.value ? [e.target.value] : [] })
                }
                placeholder="Not answered"
              >
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : numeric ? (
              <Input
                type="number"
                inputMode="decimal"
                aria-label={`Answer to ${q.questionCode ?? q.text}`}
                value={draft.numericValue}
                onChange={(e) => onAnswer({ numericValue: e.target.value })}
                placeholder={q.unit ?? "figure"}
              />
            ) : q.itemType === "long_text" ? (
              <Textarea
                rows={2}
                aria-label={`Answer to ${q.questionCode ?? q.text}`}
                value={draft.response}
                onChange={(e) => onAnswer({ response: e.target.value })}
              />
            ) : (
              <Input
                type={q.itemType === "date" ? "date" : "text"}
                aria-label={`Answer to ${q.questionCode ?? q.text}`}
                value={draft.response}
                onChange={(e) => onAnswer({ response: e.target.value })}
              />
            )}
            {q.evidenceRequired && (recorded?.fileIds.length ?? 0) === 0 ? (
              <p className="mt-0.5 text-2xs text-warning-fg">
                This question requires evidence
                {q.evidenceKinds.length > 0 ? ` (${q.evidenceKinds.join(", ")})` : ""} and none is
                attached, so the answer will be refused until a file is linked.
              </p>
            ) : null}
          </div>
          {scoreable && (q.maxScore ?? 0) > 0 ? (
            <div className="w-28">
              <label className="text-2xs uppercase text-content-subtle">
                Score / {num(q.maxScore, 0)}
              </label>
              <Input
                type="number"
                inputMode="decimal"
                aria-label={`Score for ${q.questionCode ?? q.text}`}
                value={score}
                onChange={(e) => onScore(e.target.value)}
                placeholder="—"
              />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap items-end justify-between gap-2">
          <p className="text-meta">
            <span className="text-content-subtle">Answer: </span>
            {recorded
              ? (recorded.response ??
                (recorded.numericValue !== null
                  ? String(recorded.numericValue)
                  : recorded.selectedOptions.join(", ")) ??
                "—")
              : "not answered"}
            {recorded && recorded.score !== null ? (
              <span className="ml-2 text-2xs text-content-subtle">
                scored {num(recorded.score, 1)} / {num(recorded.maxScore, 1)}
              </span>
            ) : q.required ? (
              <span className="ml-2 text-2xs italic text-warning-fg">not scored</span>
            ) : null}
          </p>
          {scoreable && (q.maxScore ?? 0) > 0 ? (
            <div className="w-28">
              <label className="text-2xs uppercase text-content-subtle">
                Score / {num(q.maxScore, 0)}
              </label>
              <Input
                type="number"
                inputMode="decimal"
                aria-label={`Score for ${q.questionCode ?? q.text}`}
                value={score}
                onChange={(e) => onScore(e.target.value)}
                placeholder="—"
              />
            </div>
          ) : null}
        </div>
      )}
    </li>
  );
}

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

      <QuestionnaireDrawer
        questionnaireId={openId}
        onClose={() => setOpenId(null)}
        onMutated={() => setVersion((n) => n + 1)}
      />

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

/**
 * ONE QUESTIONNAIRE, AND THE PLACE ITS QUESTIONS ARE WRITTEN.
 *
 * The register was previously read-only from the browser: a questionnaire
 * could be created and then never filled in, never activated, and therefore
 * never issued — the whole feature silently no-opped for anyone who was not
 * driving the API by hand. A question set that decides who may work for this
 * company is authored here, reviewed by somebody else, and frozen the moment
 * it goes live.
 */
function QuestionnaireDrawer({
  questionnaireId,
  onClose,
  onMutated,
}: {
  questionnaireId: string | null;
  onClose: () => void;
  onMutated: () => void;
}) {
  const detail = useResource<QuestionnaireDetail>(
    questionnaireId ? `${BASE}/questionnaires/${questionnaireId}` : null,
  );
  const action = useAction();
  const nameOf = useNames();
  const [addOpen, setAddOpen] = useState(false);
  const q = detail.data;
  const isDraft = q?.status === "draft";

  function refresh() {
    detail.reload();
    onMutated();
  }

  async function activate() {
    if (!q) return;
    const done = await action.run("activate", () =>
      api.post(`${BASE}/questionnaires/${q.id}/activate`, {}),
    );
    if (done) refresh();
  }

  async function retire() {
    if (!q) return;
    const done = await action.run("retire", () =>
      api.post(`${BASE}/questionnaires/${q.id}/retire`, {}),
    );
    if (done) refresh();
  }

  async function removeQuestion(questionId: string) {
    const done = await action.run(`del:${questionId}`, () =>
      api.del(`${BASE}/questions/${questionId}`),
    );
    if (done) refresh();
  }

  return (
    <>
      <Drawer
        open={questionnaireId !== null}
        onClose={onClose}
        size="xl"
        title={q ? `${q.reference} — ${q.name}` : "Questionnaire"}
        description={
          q
            ? q.status === "draft"
              ? "Draft — the questions can still be written, and nothing has been issued against it."
              : q.status === "active"
                ? "Active and frozen. Vendors have been assessed against these questions."
                : "Retired. It stays readable because past assessments were made against it."
            : undefined
        }
        footer={
          q ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              {q.status === "active" ? (
                <Button
                  variant="secondary"
                  loading={action.busy === "retire"}
                  onClick={() => void retire()}
                >
                  Retire
                </Button>
              ) : null}
              {isDraft ? (
                <>
                  <Button variant="secondary" icon={IconPlus} onClick={() => setAddOpen(true)}>
                    Add a question
                  </Button>
                  <Button
                    icon={IconCheck}
                    loading={action.busy === "activate"}
                    onClick={() => void activate()}
                    disabled={q.questions.length === 0}
                  >
                    Activate
                  </Button>
                </>
              ) : null}
            </div>
          ) : null
        }
      >
        {detail.loading && !q ? (
          <LoadingBlock rows={3} />
        ) : detail.error ? (
          <LoadError message={detail.error} onRetry={detail.reload} />
        ) : q ? (
          <div className="space-y-4">
            <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

            {isDraft ? (
              <Alert tone="info" variant="subtle" title="What activation means">
                <p>
                  Activation is this questionnaire&rsquo;s approval, and it is never the
                  author&rsquo;s to give: whoever created it cannot activate it. A validity period
                  must be set first, because an approval that never expires is a check done once
                  and relied on forever.
                </p>
                {q.validityMonths === null ? (
                  <p className="mt-1 text-meta text-warning-fg">
                    No validity period is set on this questionnaire, so activation will be refused.
                    Set one on the register before activating.
                  </p>
                ) : null}
                {q.questions.length === 0 ? (
                  <p className="mt-1 text-meta text-warning-fg">
                    No questions have been written yet. A questionnaire with no questions cannot be
                    issued to the supply chain.
                  </p>
                ) : null}
              </Alert>
            ) : null}

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
                {
                  label: "Activated by",
                  value: q.approvedBy ? nameOf(q.approvedBy) : "not activated",
                  hint: "Never the person who wrote it.",
                  tone: q.approvedBy ? ("success" as const) : undefined,
                },
                {
                  label: "Maximum score",
                  value: q.maxScore === null ? "—" : num(q.maxScore, 1),
                  hint: "Sum of each question's maximum times its weight.",
                },
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
                        <span className="text-content-subtle">
                          {" "}
                          — fails on &ldquo;{k.knockoutValue}&rdquo;
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            <section>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-label uppercase text-content-subtle">All questions</h3>
                {isDraft ? (
                  <Button size="xs" variant="secondary" icon={IconPlus} onClick={() => setAddOpen(true)}>
                    Add a question
                  </Button>
                ) : null}
              </div>
              {q.questions.length === 0 ? (
                <EmptyState
                  className="mt-2"
                  icon={IconCompliance}
                  title="No questions yet"
                  hint="Write the questions the supply chain is screened on: the knockouts that fail a vendor outright, and the weighted questions that score the rest."
                  action={
                    isDraft ? (
                      <Button icon={IconPlus} onClick={() => setAddOpen(true)}>
                        Add the first question
                      </Button>
                    ) : null
                  }
                />
              ) : (
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
                        <div className="flex shrink-0 items-center gap-1">
                          {question.isKnockout ? (
                            <Badge tone="danger" size="xs">
                              knockout
                            </Badge>
                          ) : null}
                          <Badge tone="neutral" size="xs">
                            weight {num(question.weight, 0)}
                          </Badge>
                          {isDraft ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              icon={IconTrash}
                              iconOnly
                              aria-label={`Delete question ${question.questionCode ?? question.text}`}
                              loading={action.busy === `del:${question.id}`}
                              onClick={() => void removeQuestion(question.id)}
                            />
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-0.5 text-2xs text-content-subtle">
                        {titleCase(question.category)} · {titleCase(question.itemType)}
                        {question.required ? " · required" : " · optional"}
                        {question.maxScore !== null ? ` · max ${num(question.maxScore, 0)}` : " · unscored"}
                        {question.evidenceRequired ? " · evidence required" : ""}
                        {question.options.length > 0 ? ` · ${question.options.join(" / ")}` : ""}
                      </p>
                      {question.guidance ? (
                        <p className="mt-0.5 text-2xs italic text-content-subtle">{question.guidance}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}
      </Drawer>

      <AddQuestionModal
        open={addOpen}
        questionnaireId={q?.id ?? null}
        onClose={() => setAddOpen(false)}
        onDone={() => {
          setAddOpen(false);
          refresh();
        }}
      />
    </>
  );
}

/** Item types a vendor cannot meaningfully answer in this register. */
const QUESTION_ITEM_TYPES = CHECKLIST_ITEM_TYPES.filter(
  (t) => t !== "instrument_reading" && t !== "temperature" && t !== "measurement",
);

const CHOICE_ITEM_TYPES = new Set(["single_select", "multi_select", "pass_fail", "pass_fail_na", "yes_no"]);

function AddQuestionModal({
  open,
  questionnaireId,
  onClose,
  onDone,
}: {
  open: boolean;
  questionnaireId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [text, setText] = useState("");
  const [questionCode, setQuestionCode] = useState("");
  const [category, setCategory] = useState<string>("technical_capability");
  const [itemType, setItemType] = useState<string>("yes_no");
  const [required, setRequired] = useState(true);
  const [options, setOptions] = useState("");
  const [weight, setWeight] = useState("1");
  const [maxScore, setMaxScore] = useState("10");
  const [isKnockout, setIsKnockout] = useState(false);
  const [knockoutValue, setKnockoutValue] = useState("");
  const [evidenceRequired, setEvidenceRequired] = useState(false);
  const [guidance, setGuidance] = useState("");

  const declaredOptions = options
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  const needsOptions = CHOICE_ITEM_TYPES.has(itemType) && itemType !== "yes_no" && itemType !== "pass_fail" && itemType !== "pass_fail_na";

  async function submit() {
    if (!questionnaireId) return;
    const body: Record<string, unknown> = {
      text: text.trim(),
      category,
      itemType,
      required,
      weight: Number(weight) || 1,
      isKnockout,
      evidenceRequired,
    };
    if (questionCode.trim()) body["questionCode"] = questionCode.trim();
    if (declaredOptions.length > 0) body["options"] = declaredOptions;
    if (maxScore.trim()) body["maxScore"] = Number(maxScore);
    if (isKnockout && knockoutValue.trim()) body["knockoutValue"] = knockoutValue.trim();
    if (guidance.trim()) body["guidance"] = guidance.trim();
    const done = await action.run("add", () =>
      api.post(`${BASE}/questionnaires/${questionnaireId}/questions`, body),
    );
    if (done) {
      setText("");
      setQuestionCode("");
      setKnockoutValue("");
      setGuidance("");
      onDone();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a question"
      description="Questions can only be written while the questionnaire is a draft — once it is active, changing them would silently change what past assessments meant."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={action.busy === "add"}
            disabled={text.trim().length === 0 || (needsOptions && declaredOptions.length === 0)}
          >
            Add it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        <Field label="Question" required>
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Has the company been prosecuted by a health and safety regulator in the last five years?"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" optional hint="Used in refusals so a failure names the question.">
            <Input
              value={questionCode}
              onChange={(e) => setQuestionCode(e.target.value)}
              placeholder="HS-01"
            />
          </Field>
          <Field label="Category" required>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {PREQUAL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Answer type" required>
            <Select value={itemType} onChange={(e) => setItemType(e.target.value)}>
              {QUESTION_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Options"
            optional={!needsOptions}
            required={needsOptions}
            hint="Comma separated. A select with no options cannot be answered and cannot be scored."
          >
            <Input
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              placeholder="Yes, No, Not applicable"
            />
          </Field>
          <Field label="Weight" hint="Multiplies this question's score in the total.">
            <Input
              type="number"
              inputMode="decimal"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          </Field>
          <Field
            label="Maximum score"
            optional
            hint="Leave blank for a question that is recorded but not scored."
          >
            <Input
              type="number"
              inputMode="decimal"
              value={maxScore}
              onChange={(e) => setMaxScore(e.target.value)}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-meta">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          Required — the submission cannot be sent in without it
        </label>
        <label className="flex items-center gap-2 text-meta">
          <input
            type="checkbox"
            checked={evidenceRequired}
            onChange={(e) => setEvidenceRequired(e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          Evidence required — an answer with no attachment is refused
        </label>
        <label className="flex items-center gap-2 text-meta">
          <input
            type="checkbox"
            checked={isKnockout}
            onChange={(e) => setIsKnockout(e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          Knockout — a wrong answer fails the submission outright, whatever it scored elsewhere
        </label>
        {isKnockout ? (
          <Field
            label="Disqualifying answer"
            required
            hint="Must be one of the declared options. A disqualifying answer nobody can give disqualifies nobody."
          >
            <Input
              value={knockoutValue}
              onChange={(e) => setKnockoutValue(e.target.value)}
              placeholder="Yes"
            />
          </Field>
        ) : null}
        <Field label="Guidance" optional hint="Shown to whoever answers and whoever scores it.">
          <Textarea rows={2} value={guidance} onChange={(e) => setGuidance(e.target.value)} />
        </Field>
      </div>
    </Modal>
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
