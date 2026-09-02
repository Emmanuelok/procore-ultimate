/**
 * CORRESPONDENCE, TRANSMITTALS, ACTION PLANS & FORMS — spec Vol I §2.11–2.13
 * (#440–464) and #99, routed at /projects/:projectId/correspondence.
 *
 * One idea runs through every tab: a record that leaves the tenant, or that
 * somebody is asked to complete, carries a NAMED PERSON and a DEADLINE, and
 * this workspace's job is to say, at a glance, who owes what to whom and how
 * late it is.
 *
 *   Letters       the numbered register, threaded, with the ball-in-court and
 *                 the response deadline on every row
 *   Transmittals  what was issued, for what purpose, and who has actually
 *                 acknowledged receipt — silence is never counted as receipt
 *   Action plans  required activities, evidence before sign-off, multi-party
 *                 signatures and the quality checkpoints that hold the rest
 *   Forms         the template library with its branching logic, assignment,
 *                 completion with a signature, and the register export
 *   Inbound       every parsed email this project captured, and exactly why
 *                 routing filed it where it did
 *   Setup         the correspondence types this tenant issues under
 */
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Badge, PageHeader, Stat, Tabs } from "../../ui";
import { IconMail } from "../../ui/icons";
import ActionPlansTab from "./ActionPlansTab";
import FormsTab from "./FormsTab";
import InboundTab from "./InboundTab";
import LettersTab from "./LettersTab";
import SetupTab from "./SetupTab";
import TransmittalsTab from "./TransmittalsTab";
import { ReasonList, count, days, pct, titleCase, useSummary } from "./correspondenceShared";

type TabKey = "letters" | "transmittals" | "plans" | "forms" | "inbound" | "setup";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "letters", label: "Letters" },
  { value: "transmittals", label: "Transmittals" },
  { value: "plans", label: "Action plans" },
  { value: "forms", label: "Forms" },
  { value: "inbound", label: "Inbound" },
  { value: "setup", label: "Setup" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function CorrespondencePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get("tab");
    return isTabKey(t) ? t : "letters";
  });

  const selectTab = useCallback(
    (key: TabKey) => {
      setTab(key);
      setSearchParams({ tab: key }, { replace: true });
    },
    [setSearchParams],
  );

  const summary = useSummary(projectId ?? "");
  const s = summary.data;

  if (!projectId) return null;

  const tabItems = TABS.map((t) => {
    if (t.value === "letters" && s && s.letters.overdue > 0) {
      return { ...t, count: s.letters.overdue, tone: "danger" as const };
    }
    if (t.value === "transmittals" && s && s.transmittals.overdueAcks > 0) {
      return { ...t, count: s.transmittals.overdueAcks, tone: "danger" as const };
    }
    if (t.value === "plans" && s && s.plans.overdueActivities > 0) {
      return { ...t, count: s.plans.overdueActivities, tone: "warning" as const };
    }
    if (t.value === "forms" && s && s.forms.overdueAssignments > 0) {
      return { ...t, count: s.forms.overdueAssignments, tone: "warning" as const };
    }
    if (t.value === "inbound" && s && s.inbound.unmatched > 0) {
      return { ...t, count: s.inbound.unmatched, tone: "warning" as const };
    }
    return t;
  });

  return (
    <div>
      <PageHeader
        icon={IconMail}
        title="Correspondence & Forms"
        subtitle="Letters, transmittals, action plans and forms — every deadline chased, every acknowledgement recorded, and inbound email filed onto the thread it answers"
        meta={
          s ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={s.letters.ballWithUs > 0 ? "warning" : "neutral"} size="xs">
                {count(s.letters.ballWithUs)} in our court
              </Badge>
              <Badge tone={s.letters.ballWithRecipient > 0 ? "info" : "neutral"} size="xs">
                {count(s.letters.ballWithRecipient)} awaiting the other side
              </Badge>
              {s.openSignals > 0 ? (
                <Badge tone="danger" size="xs" dot>
                  {count(s.openSignals)} open correspondence signals
                </Badge>
              ) : null}
            </span>
          ) : null
        }
        tabs={<Tabs items={tabItems} value={tab} onChange={selectTab} />}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Open letters"
          value={s ? count(s.letters.open) : "—"}
          hint={s ? `${count(s.letters.awaitingResponse)} awaiting a response` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Responses overdue"
          value={s ? count(s.letters.overdue) : "—"}
          tone={s && s.letters.overdue > 0 ? "danger" : undefined}
          hint={s ? `${count(s.letters.dueSoon)} due within 3 days` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Average response"
          value={s && s.letters.averageResponseDays !== null ? days(s.letters.averageResponseDays) : "—"}
          hint={s ? s.letters.averageResponseBasis : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Acknowledgements"
          value={
            s && s.transmittals.acknowledgementRate.value !== null
              ? pct(s.transmittals.acknowledgementRate.value)
              : "—"
          }
          tone={s && s.transmittals.overdueAcks > 0 ? "danger" : undefined}
          hint={
            s
              ? s.transmittals.acknowledgementRate.value === null
                ? s.transmittals.acknowledgementRate.reasons[0]
                : `${count(s.transmittals.outstandingAcks)} outstanding · ${count(s.transmittals.overdueAcks)} overdue`
              : undefined
          }
          loading={summary.loading}
        />
        <Stat
          label="Action plans"
          value={s ? count(s.plans.active + s.plans.blocked) : "—"}
          tone={s && s.plans.blocked > 0 ? "danger" : undefined}
          hint={
            s
              ? `${count(s.plans.blocked)} blocked · ${count(s.plans.overdueActivities)} overdue activities`
              : undefined
          }
          loading={summary.loading}
        />
        <Stat
          label="Forms outstanding"
          value={s ? count(s.forms.openAssignments) : "—"}
          tone={s && s.forms.overdueAssignments > 0 ? "warning" : undefined}
          hint={
            s
              ? `${count(s.forms.overdueAssignments)} overdue · ${count(s.forms.submitted)} submitted`
              : undefined
          }
          loading={summary.loading}
        />
      </div>

      {summary.error ? (
        <div className="mb-4 text-meta text-danger-text">Summary unavailable: {summary.error}</div>
      ) : s && s.reasons.length > 0 ? (
        <ReasonList reasons={s.reasons} className="mb-4" />
      ) : null}

      {tab === "letters" ? <LettersTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "transmittals" ? (
        <TransmittalsTab projectId={projectId} onChanged={summary.reload} />
      ) : null}
      {tab === "plans" ? <ActionPlansTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "forms" ? <FormsTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "inbound" ? <InboundTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "setup" ? <SetupTab projectId={projectId} onChanged={summary.reload} /> : null}
      <span className="sr-only">{titleCase(tab)}</span>
    </div>
  );
}
