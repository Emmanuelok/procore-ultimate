/**
 * THE QUALITY DASHBOARD.
 *
 * Every figure here comes from the API as `{ value, unit, inputs, reasons }`
 * and is rendered as such. A first-time-pass rate computed over zero
 * checklists is a lie that reads like a crisis, and one computed the same way
 * at 100% is a lie that reads like success — so where the inputs are missing
 * this screen says "not available" and prints the server's reason underneath.
 *
 * The four things that stop work lead the page, before any percentage:
 * unreleased hold points past their date, dispositions waiting for an
 * independent approval, overdue NCRs and turnover artefact gaps.
 */
import {
  Alert,
  BarChart,
  Button,
  ChartCard,
  DonutChart,
  Skeleton,
} from "../../ui";
import { IconAlert, IconRefresh } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CountTile,
  FigureTile,
  LoadError,
  NCR_SEVERITY_TONE,
  NothingHere,
  ReasonList,
  RefusalNotice,
  SectionTitle,
  labelize,
  money,
  num,
  pct,
  plural,
  useAction,
  type Resource,
} from "./qualityShared";
import type { QualitySummary } from "./types";

export default function OverviewTab({
  summary,
  projectId,
  onGoTo,
}: {
  summary: Resource<QualitySummary>;
  projectId: string;
  onGoTo: (tab: "itps" | "holdPoints" | "checklists" | "ncrs" | "commissioning" | "turnover") => void;
}) {
  const { busy, refusal, clear, run } = useAction();

  async function sweep() {
    const done = await run("sweep", () =>
      api.post<{ raised: number; byDetector: Record<string, number> }>(
        `/api/v1/projects/${projectId}/quality/sweep`,
        {},
      ),
    );
    if (done) summary.reload();
  }

  if (summary.error) {
    return (
      <LoadError
        message={summary.error}
        onRetry={summary.reload}
        title="The quality summary could not be loaded"
      />
    );
  }

  if (summary.loading && !summary.data) {
    return (
      <div className="space-y-3">
        <Skeleton height={110} />
        <Skeleton height={160} />
        <Skeleton height={280} />
      </div>
    );
  }

  const s = summary.data;
  if (!s) return null;

  const nothingAtAll =
    s.itps.total === 0 &&
    s.checklists.total === 0 &&
    s.ncrs.total === 0 &&
    s.commissioning.systems === 0 &&
    s.turnover.packages === 0;

  if (nothingAtAll) {
    return (
      <NothingHere
        title="This project holds no quality record at all"
        reason="No inspection and test plan, no checklist, no NCR, no commissionable system and no turnover package. That is not a clean project — it is a project where the assurance chain has not been started, so nothing on site is gated and every figure on this page would have no denominator."
        action={
          <Button size="sm" onClick={() => onGoTo("itps")}>
            Start with an inspection and test plan
          </Button>
        }
      />
    );
  }

  const ncrCurrency =
    typeof s.ncrs.totalCostImpact.inputs["currency"] === "string"
      ? (s.ncrs.totalCostImpact.inputs["currency"] as string)
      : "USD";

  const severityData = Object.entries(s.ncrs.bySeverity).map(([severity, count]) => ({
    severity: labelize(severity),
    count,
    tone: NCR_SEVERITY_TONE[severity] ?? "neutral",
  }));
  const cxData = Object.entries(s.commissioning.byStatus).map(([status, count]) => ({
    label: labelize(status),
    value: count,
  }));
  const resultData = Object.entries(s.checklists.byResult).map(([result, count]) => ({
    label: labelize(result),
    value: count,
  }));

  return (
    <div className="space-y-5">
      <RefusalNotice refusal={refusal} onDismiss={clear} />

      {/* ---------------- what stops work ---------------- */}
      <section className="space-y-2.5">
        <SectionTitle
          title="What is stopping work"
          hint="Counts, not percentages — each of these is a named record somebody has to act on."
          actions={
            <Button size="sm" variant="ghost" icon={IconRefresh} loading={busy === "sweep"} onClick={sweep}>
              Run the detectors
            </Button>
          }
        />
        <p className="text-2xs text-content-subtle">
          The detectors run lazily on every list read and are idempotent — reading this page has
          already run them, and running them again over an unchanged project raises nothing. There
          is no scheduled job behind them, so nothing here is waiting on a cron to notice it.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <CountTile
            label="Hold points past their date"
            value={s.holdPoints.overdue}
            tone="danger"
            emphasis
            hint={`of ${s.holdPoints.open} still open, ${s.holdPoints.total} in total`}
          />
          <CountTile
            label="Dispositions awaiting approval"
            value={s.ncrs.awaitingDispositionApproval}
            tone="warning"
            emphasis
            hint="Proposed by one person, not yet agreed by anybody else"
          />
          <CountTile
            label="NCRs past their response date"
            value={s.ncrs.overdue}
            tone="danger"
            emphasis
            hint={`of ${s.ncrs.open} open, ${s.ncrs.total} in total`}
          />
          <CountTile
            label="Packages with an artefact gap"
            value={s.turnover.gaps.length}
            tone="danger"
            emphasis
            hint={`of ${s.turnover.packages} ${plural(s.turnover.packages, "package")}`}
          />
        </div>

        {s.holdPoints.overdue > 0 ? (
          <Alert
            tone="danger"
            icon={IconAlert}
            title={`${s.holdPoints.overdue} unreleased hold ${plural(s.holdPoints.overdue, "point")} past ${plural(s.holdPoints.overdue, "its", "their")} planned date`}
            actions={
              <Button size="sm" variant="secondary" onClick={() => onGoTo("holdPoints")}>
                Open the board
              </Button>
            }
          >
            Either the work is standing idle waiting for a verifier, or it went ahead without one.
            The platform cannot tell which from the data it holds — which is precisely why a human
            is being asked.
          </Alert>
        ) : null}

        {s.holdPoints.openWithoutNoticeServed > 0 ? (
          <Alert
            tone="warning"
            size="sm"
            title={`${s.holdPoints.openWithoutNoticeServed} open hold ${plural(s.holdPoints.openWithoutNoticeServed, "point")} ${plural(s.holdPoints.openWithoutNoticeServed, "has", "have")} had no notice served`}
          >
            The dispute is never about whether the verifier turned up; it is about whether notice
            was given. Until notice is recorded there is nothing to argue from.
          </Alert>
        ) : null}

        {s.ncrs.overdueReferences.length > 0 ? (
          <Alert
            tone="danger"
            size="sm"
            title="Overdue NCRs"
            actions={
              <Button size="sm" variant="secondary" onClick={() => onGoTo("ncrs")}>
                Open the register
              </Button>
            }
          >
            {s.ncrs.overdueReferences.join(", ")}
          </Alert>
        ) : null}

        {s.commissioning.systemsWithoutTwinAsset.length > 0 ? (
          <Alert
            tone="warning"
            size="sm"
            title={`${s.commissioning.systemsWithoutTwinAsset.length} commissioning ${plural(s.commissioning.systemsWithoutTwinAsset.length, "system")} not bound to a twin asset`}
            actions={
              <Button size="sm" variant="secondary" onClick={() => onGoTo("commissioning")}>
                Open the register
              </Button>
            }
          >
            {s.commissioning.systemsWithoutTwinAsset.slice(0, 15).join(", ")}
            {s.commissioning.systemsWithoutTwinAsset.length > 15
              ? `, and ${s.commissioning.systemsWithoutTwinAsset.length - 15} more`
              : ""}
            . Handover writes INTO the twin&apos;s asset register; a system with no asset has
            nothing to hand over into.
          </Alert>
        ) : null}
      </section>

      {/* ---------------- the figures ---------------- */}
      <section className="space-y-2.5">
        <SectionTitle
          title="The figures"
          hint="Each one states its inputs. Where an input is missing the figure is unavailable, never zero."
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <FigureTile
            label="First-time pass rate"
            figure={s.checklists.firstTimePassRate}
            render={(v) => pct(v)}
            hint={`over ${num(Number(s.checklists.firstTimePassRate.inputs["judgedChecklists"] ?? 0), 0)} judged ${plural(Number(s.checklists.firstTimePassRate.inputs["judgedChecklists"] ?? 0), "checklist")}`}
            tone="success"
          />
          <FigureTile
            label="Median release latency"
            figure={s.holdPoints.medianReleaseLatencyHours}
            render={(v) => `${num(v, 1)} h`}
            hint="Notice served → point released"
            tone="info"
          />
          <FigureTile
            label="Median NCR closure"
            figure={s.ncrs.medianClosureDays}
            render={(v) => `${num(v, 1)} ${plural(v, "day")}`}
            hint="Detected → independently verified"
            tone="info"
          />
          <FigureTile
            label={`Cost of non-conformance · ${ncrCurrency}`}
            figure={s.ncrs.totalCostImpact}
            render={(v) => money(v, ncrCurrency)}
            hint="Only NCRs carrying a recorded cost"
            tone="warning"
          />
          <FigureTile
            label="Turnover artefact completeness"
            figure={s.turnover.artefactCompleteness}
            render={(v) => pct(v)}
            hint="Present required artefacts over required ones"
            tone="accent"
          />
        </div>
      </section>

      {/* ---------------- the registers ---------------- */}
      <section className="space-y-2.5">
        <SectionTitle title="The registers" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <CountTile label="Plans" value={s.itps.total} hint={`${s.holdPoints.total} intervention ${plural(s.holdPoints.total, "point")}`} />
          <CountTile label="Checklists" value={s.checklists.total} hint={`${s.checklists.criticalFailures} critical ${plural(s.checklists.criticalFailures, "failure")}`} />
          <CountTile label="NCRs" value={s.ncrs.total} hint={`${s.ncrs.backcharged} backcharged`} />
          <CountTile label="Systems" value={s.commissioning.systems} hint={`${s.commissioning.openDeficiencies} open ${plural(s.commissioning.openDeficiencies, "deficiency", "deficiencies")}`} />
          <CountTile label="Turnover packages" value={s.turnover.packages} hint={`${s.turnover.handedOver} handed over`} />
          <CountTile label="Assets handed over" value={s.turnover.assetsHandedOver} hint="Into the twin's register" />
        </div>
      </section>

      {/* ---------------- distributions ---------------- */}
      <section className="grid gap-3 lg:grid-cols-3">
        {severityData.length > 0 ? (
          <ChartCard
            title="NCRs by severity"
            subtitle="Critical means structural integrity, life safety or a statutory approval."
          >
            <BarChart
              data={severityData}
              categoryKey="severity"
              series={[{ key: "count", label: "NCRs", tone: "danger" }]}
              height={220}
              valueFormat="number"
              ariaLabel="Non-conformance reports by severity"
            />
          </ChartCard>
        ) : null}

        {resultData.length > 0 ? (
          <ChartCard
            title="Checklist verdicts"
            subtitle="Only records that reached a verdict. Unjudged ones are excluded rather than counted as passes."
            footnote={`${s.checklists.total - resultData.reduce((n, d) => n + d.value, 0)} of ${s.checklists.total} checklists carry no verdict yet and are not shown.`}
          >
            <DonutChart
              data={resultData}
              labelKey="label"
              valueKey="value"
              height={220}
              ariaLabel="Checklists by verdict"
            />
          </ChartCard>
        ) : (
          <ChartCard title="Checklist verdicts" subtitle="Nothing has reached a verdict yet.">
            <div className="p-4 text-meta text-content-subtle">
              No checklist on this project has been completed with a result, so there is no
              distribution to draw. A chart of zeros would read as a finding.
            </div>
          </ChartCard>
        )}

        {cxData.length > 0 ? (
          <ChartCard
            title="Commissioning ladder"
            subtitle="Where the project's systems sit. The ladder is a gate, not a label."
          >
            <BarChart
              data={cxData}
              categoryKey="label"
              series={[{ key: "value", label: "Systems", tone: "accent" }]}
              orientation="horizontal"
              height={Math.max(220, cxData.length * 28 + 60)}
              valueFormat="number"
              ariaLabel="Commissioning systems by ladder position"
            />
          </ChartCard>
        ) : null}
      </section>

      {/* ---------------- honesty footnotes ---------------- */}
      {[
        s.checklists.firstTimePassRate,
        s.holdPoints.medianReleaseLatencyHours,
        s.ncrs.medianClosureDays,
        s.ncrs.totalCostImpact,
        s.turnover.artefactCompleteness,
      ].some((f) => f.reasons.length > 0) ? (
        <section className="rounded-lg border border-border bg-surface-raised p-3">
          <p className="text-label uppercase tracking-wide text-content-subtle">
            Why some figures above are unavailable or qualified
          </p>
          <ReasonList
            className="mt-1.5"
            reasons={[
              ...s.checklists.firstTimePassRate.reasons,
              ...s.holdPoints.medianReleaseLatencyHours.reasons,
              ...s.ncrs.medianClosureDays.reasons,
              ...s.ncrs.totalCostImpact.reasons,
              ...s.turnover.artefactCompleteness.reasons,
            ]}
          />
        </section>
      ) : null}
    </div>
  );
}
