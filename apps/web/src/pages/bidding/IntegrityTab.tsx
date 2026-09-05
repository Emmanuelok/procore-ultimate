/**
 * INTEGRITY — what the shape of these bids says.
 *
 * A rigged tender looks fine from inside one package: every bid is signed,
 * every envelope is sealed, every price is different. The signature is
 * STATISTICAL, so this screen shows the statistics next to the finding and
 * never asks anyone to take a verdict on trust:
 *
 *   the spread     coefficient of variation across the contenders, with the
 *                  threshold that fired stated beside it
 *   the findings   each with the numbers it was computed from, the records it
 *                  was computed over, and the innocent explanations to check
 *   abnormal       who is far below or far above the field, and whether the
 *                  price explanation is on the record yet
 *   unbalanced     whose rates are front-loaded, cell by cell
 *   scope gaps     which scope nobody priced — the reason a low bid is low
 *
 * A FINDING IS A QUESTION, NOT AN ACCUSATION. The ordinary outcome is an
 * explanation recorded next to it, which is why dismissing one requires a
 * reason and why the register keeps the dismissal.
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
  EmptyState,
  Modal,
  Stat,
  Table,
  Td,
  Th,
} from "../../ui";
import type { DataColumns } from "../../ui";
import { IconAssurance, IconLock, IconRefresh, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  LoadError,
  LoadingBlock,
  ReasonList,
  RefusalPanel,
  money,
  num,
  pct,
  titleCase,
  useAction,
  useReason,
  useResource,
} from "./biddingShared";
import type {
  IntegrityFinding,
  PackageDetail,
  PackageIntegrity,
  ScopeGap,
  ScopeGapReport,
  UnbalancedAssessment,
} from "./types";

const SEVERITY_TONE: Record<string, "danger" | "warning" | "info" | "neutral"> = {
  critical: "danger",
  high: "danger",
  medium: "warning",
  low: "info",
  info: "neutral",
};

const DETECTOR_LABEL: Record<string, string> = {
  bid_integrity_price_clustering: "Prices clustered",
  bid_integrity_price_dispersion: "Prices dispersed",
  bid_integrity_identical_rates: "Identical unit rates",
  bid_integrity_constant_ratio: "Constant-ratio bill",
  bid_integrity_submission_clustering: "Submissions clustered in time",
  bid_integrity_cover_bidding: "Cover bidding",
  bid_integrity_winner_rotation: "Winner rotation",
  bid_integrity_repeat_invitation_set: "Unchanging bidder list",
  bid_integrity_abnormally_low: "Abnormally low tender",
  bid_integrity_abnormally_high: "Abnormally high tender",
  bid_integrity_unbalanced_bid: "Unbalanced bid",
  bid_integrity_approval_velocity: "Approval velocity",
  bid_integrity_out_of_hours_approval: "Out-of-hours approval",
  bid_integrity_withdrawal_pattern: "Withdrawal pattern",
  bid_integrity_late_submission_win: "Late bid won",
};

export const detectorLabel = (detector: string): string =>
  DETECTOR_LABEL[detector] ?? titleCase(detector.replace("bid_integrity_", ""));

export default function IntegrityTab({
  projectId,
  packageId,
  pkg,
  onMutated,
}: {
  projectId: string;
  packageId: string;
  pkg: PackageDetail | null;
  onMutated: () => void;
}) {
  const [version, setVersion] = useState(0);
  const integrity = useResource<PackageIntegrity>(
    packageId
      ? `/api/v1/projects/${projectId}/bid-packages/${packageId}/integrity?_v=${version}`
      : null,
  );
  const gaps = useResource<ScopeGapReport>(
    packageId
      ? `/api/v1/projects/${projectId}/bid-packages/${packageId}/scope-gaps?_v=${version}`
      : null,
  );
  const action = useAction();
  const reason = useReason();
  const [open, setOpen] = useState<IntegrityFinding | null>(null);

  function refresh() {
    setVersion((n) => n + 1);
    onMutated();
  }

  const data = integrity.data;
  const currency = pkg?.currency ?? "USD";

  const openSignalByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of data?.signals ?? []) {
      const refs = s.evidenceRefs as { key?: string } | null;
      if (refs?.key && s.disposition !== "dismissed" && s.disposition !== "closed") {
        map.set(refs.key, s.id);
      }
    }
    return map;
  }, [data]);

  async function runDetectors() {
    const res = await action.run("run", () =>
      api.post<{ raised: string[]; alreadyOpen: string[]; note: string }>(
        `/api/v1/projects/${projectId}/bid-packages/${packageId}/integrity/run`,
        {},
      ),
    );
    if (res) refresh();
  }

  async function dismiss(signalId: string) {
    const text = await reason.ask({
      title: "Dismiss this finding",
      description:
        "A dismissal with a stated reason is what makes the detector's precision measurable: a " +
        "detector whose findings are always dismissed should be re-tuned or retired, and that " +
        "only becomes visible if the dismissals are counted.",
      label: "What was checked, and what was found",
      confirmLabel: "Dismiss",
      minLength: 3,
    });
    if (!text) return;
    const res = await action.run(signalId, () =>
      api.post(`/api/v1/companies/current/bid-integrity/${signalId}/dismiss`, { reason: text }),
    );
    if (res) refresh();
  }

  if (integrity.loading && !data) return <LoadingBlock rows={4} />;
  if (integrity.error) return <LoadError message={integrity.error} onRetry={integrity.reload} />;
  if (!data) return null;

  if (data.sealed) {
    return (
      <Alert tone="warning" title="Integrity analysis is withheld while the seal is on" icon={IconLock}>
        <p className="whitespace-pre-wrap">{data.note}</p>
        <p className="mt-2 text-meta text-content-muted">{data.seal.note}</p>
      </Alert>
    );
  }

  const findings = data.findings ?? [];
  const abnormal = data.abnormal?.assessments ?? [];
  const unbalanced = (data.unbalanced ?? []).filter((u) => u.unbalanced);
  const gapReport = gaps.data;

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalPanel refusal={action.refusal} onDismiss={action.clear} /> : null}

      {/* ------------------------------------------------------------ */}
      {/* The spread                                                    */}
      {/* ------------------------------------------------------------ */}
      <Card>
        <CardHeader
          title="The shape of this tender"
          subtitle={
            data.comparisonBasis === "levelled"
              ? "Measured on the LEVELLED amounts — the like-for-like figures."
              : "Measured on AS-BID totals: this package has not been levelled, so scope " +
                "differences are still inside the numbers."
          }
          actions={
            <Button
              size="sm"
              variant="secondary"
              icon={IconRefresh}
              onClick={runDetectors}
              loading={action.busy === "run"}
            >
              Run detectors
            </Button>
          }
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Contenders" value={String(data.dispersion?.n ?? 0)} />
            <Stat
              label="Spread (CV)"
              value={data.dispersion?.cvPercent === null || data.dispersion === null
                ? "—"
                : pct(data.dispersion.cvPercent, 2)}
              hint={`clustering below ${data.thresholds["clusteringCvPercent"]}%, dispersion above ${data.thresholds["dispersionCvPercent"]}%`}
            />
            <Stat
              label="Lowest"
              value={data.dispersion?.min === null || data.dispersion === null ? "—" : money(data.dispersion.min, currency)}
            />
            <Stat
              label="Median"
              value={data.dispersion?.median === null || data.dispersion === null ? "—" : money(data.dispersion.median, currency)}
            />
            <Stat
              label="Highest"
              value={data.dispersion?.max === null || data.dispersion === null ? "—" : money(data.dispersion.max, currency)}
            />
          </div>
          <p className="mt-3 text-meta leading-relaxed text-content-muted">{data.note}</p>
          {data.notRun.length > 0 ? (
            <ReasonList
              className="mt-3"
              heading="Detectors that could not run"
              tone="warning"
              reasons={data.notRun.map((n) => `${detectorLabel(n.detector)}: ${n.reason}`)}
            />
          ) : null}
        </CardBody>
      </Card>

      {/* ------------------------------------------------------------ */}
      {/* Findings                                                      */}
      {/* ------------------------------------------------------------ */}
      <Card>
        <CardHeader
          title="Findings"
          subtitle="A question, not an accusation. Each one carries the statistic it was computed from."
          actions={
            findings.length > 0 ? (
              <Badge tone="warning" size="sm">
                {findings.length} open
              </Badge>
            ) : null
          }
        />
        <CardBody>
          {findings.length === 0 ? (
            <EmptyState
              icon={IconAssurance}
              title="Nothing found on this package"
              hint={data.note}
            />
          ) : (
            <ul className="space-y-3">
              {findings.map((f) => {
                const signalId = openSignalByKey.get(f.key);
                return (
                  <li
                    key={f.key}
                    className="rounded-lg border border-border bg-surface-raised p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={SEVERITY_TONE[f.severity] ?? "neutral"} size="xs" dot>
                            {titleCase(f.severity)}
                          </Badge>
                          <Badge tone="neutral" size="xs" variant="subtle">
                            {detectorLabel(f.detector)}
                          </Badge>
                          <span className="text-2xs text-content-subtle">
                            confidence {num(f.confidence * 100, 0)}%
                          </span>
                          {signalId ? (
                            <Badge tone="info" size="xs" variant="subtle">
                              on the register
                            </Badge>
                          ) : (
                            <Badge tone="neutral" size="xs" variant="subtle">
                              not yet recorded
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 font-medium">{f.title}</p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button size="xs" variant="ghost" onClick={() => setOpen(f)}>
                          Evidence
                        </Button>
                        {signalId ? (
                          <Button
                            size="xs"
                            variant="secondary"
                            loading={action.busy === signalId}
                            onClick={() => void dismiss(signalId)}
                          >
                            Dismiss with a reason
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-meta leading-relaxed text-content-muted">
                      {f.explanation}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* ------------------------------------------------------------ */}
      {/* Abnormally low / high                                         */}
      {/* ------------------------------------------------------------ */}
      <Card>
        <CardHeader
          title="Position against the field"
          subtitle="An abnormally low tender cannot be recommended until the bidder has explained the price in writing."
        />
        <CardBody flush>
          {abnormal.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No priced field to measure against"
                hint="Abnormality is measured against the median of at least three contenders, or against the pre-tender estimate where there is one."
              />
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Bidder</Th>
                  <Th align="right">Amount</Th>
                  <Th align="right">vs median</Th>
                  <Th align="right">vs estimate</Th>
                  <Th>Verdict</Th>
                </tr>
              </thead>
              <tbody>
                {abnormal.map((a) => (
                  <tr key={a.submissionId}>
                    <Td>
                      <p className="font-medium">{a.vendorName ?? a.vendorId}</p>
                      <p className="mt-0.5 text-2xs leading-snug text-content-subtle">{a.note}</p>
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {money(a.amount, currency)}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {a.deviationFromMedianPercent === null
                        ? "—"
                        : pct(a.deviationFromMedianPercent, 1)}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {a.deviationFromEstimatePercent === null
                        ? "—"
                        : pct(a.deviationFromEstimatePercent, 1)}
                    </Td>
                    <Td>
                      {a.verdict === "normal" ? (
                        <Badge tone="neutral" size="xs" variant="subtle">
                          Within range
                        </Badge>
                      ) : (
                        <div className="space-y-1">
                          <Badge
                            tone={a.verdict === "abnormally_low" ? "danger" : "warning"}
                            size="xs"
                          >
                            {a.verdict === "abnormally_low" ? "Abnormally low" : "Abnormally high"}
                          </Badge>
                          {a.requiresJustification ? (
                            <p className="text-2xs font-medium text-danger-fg">
                              Price explanation not yet recorded
                            </p>
                          ) : a.verdict === "abnormally_low" ? (
                            <p className="text-2xs text-success-fg">Explanation on the record</p>
                          ) : null}
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* ------------------------------------------------------------ */}
      {/* Unbalanced bids                                               */}
      {/* ------------------------------------------------------------ */}
      {unbalanced.length > 0 ? (
        <Card>
          <CardHeader
            title="Front-loaded rates"
            subtitle="Paid most of the money before doing most of the work — invisible in the total, obvious in the rates."
          />
          <CardBody>
            <div className="space-y-4">
              {unbalanced.map((u) => (
                <UnbalancedPanel key={u.submissionId} row={u} currency={currency} />
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------ */}
      {/* Scope gaps                                                    */}
      {/* ------------------------------------------------------------ */}
      <Card>
        <CardHeader
          title="Scope gaps across the bids"
          subtitle="The scope nobody priced is the reason the cheapest bid becomes the most expensive."
          actions={
            gapReport && gapReport.summary.universalGaps > 0 ? (
              <Badge tone="danger" size="sm">
                {gapReport.summary.universalGaps} in nobody's price
              </Badge>
            ) : null
          }
        />
        <CardBody flush>
          {gaps.loading && !gapReport ? (
            <div className="p-4">
              <LoadingBlock rows={3} />
            </div>
          ) : gaps.error ? (
            <div className="p-4">
              <LoadError message={gaps.error} onRetry={gaps.reload} />
            </div>
          ) : !gapReport || gapReport.gaps.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No scope gap on this package"
                hint={gapReport?.note ?? "Every scope row is carried by every bidder in contention."}
              />
            </div>
          ) : (
            <ScopeGapTable report={gapReport} currency={currency} />
          )}
        </CardBody>
      </Card>

      <Modal
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open ? detectorLabel(open.detector) : ""}
        size="lg"
      >
        {open ? (
          <div className="space-y-4">
            <p className="whitespace-pre-wrap text-meta leading-relaxed">{open.explanation}</p>
            <div>
              <p className="text-label uppercase text-content-subtle">The statistic</p>
              <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-meta">
                {Object.entries(open.statistic).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-content-subtle">{titleCase(k)}</dt>
                    <dd className="font-mono tabular-nums">{v === null ? "—" : String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div>
              <p className="text-label uppercase text-content-subtle">Computed over</p>
              <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-surface-sunken p-2 text-2xs leading-relaxed">
                {JSON.stringify(open.evidence, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </Modal>
      {reason.dialog}
    </div>
  );
}

function UnbalancedPanel({
  row,
  currency,
}: {
  row: UnbalancedAssessment;
  currency: string;
}) {
  const flagged = row.cells.filter((c) => c.flag !== null);
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{row.vendorName ?? row.vendorId}</p>
        <div className="flex items-center gap-2">
          <Badge tone="danger" size="xs" icon={IconWarning}>
            {row.frontLoadedLines} front-loaded · {row.starvedLines} starved
          </Badge>
          {row.frontLoadingShiftPercent !== null ? (
            <Badge tone="warning" size="xs" variant="subtle">
              {pct(row.frontLoadingShiftPercent, 1)} of value moved early
            </Badge>
          ) : null}
        </div>
      </div>
      <p className="mt-2 text-meta leading-relaxed text-content-muted">{row.note}</p>
      {flagged.length > 0 ? (
        <div className="mt-2 overflow-x-auto">
          <Table dense>
            <thead>
              <tr>
                <Th>Scope row</Th>
                <Th>Section</Th>
                <Th align="right">Their rate</Th>
                <Th align="right">Median rate</Th>
                <Th align="right">Ratio</Th>
              </tr>
            </thead>
            <tbody>
              {flagged.slice(0, 12).map((c) => (
                <tr key={c.key}>
                  <Td>{c.description}</Td>
                  <Td>
                    <Badge
                      tone={c.flag === "front_loaded" ? "danger" : "warning"}
                      size="xs"
                      variant="subtle"
                    >
                      {c.flag === "front_loaded" ? "early, over-priced" : "late, starved"}
                    </Badge>
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {money(c.rate, currency)}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {money(c.medianRate, currency)}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {num(c.ratio, 2)}x
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

function ScopeGapTable({ report, currency }: { report: ScopeGapReport; currency: string }) {
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of report.vendors ?? []) map.set(v.vendorId, v.vendorName ?? v.vendorId);
    return map;
  }, [report]);

  const columns: DataColumns<ScopeGap> = useMemo(
    () => [
      {
        id: "row",
        header: "Scope row",
        accessor: (g) => g.description,
        type: "text",
        width: 260,
        sticky: "start",
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.description}</p>
            {row.itemCode ? (
              <p className="text-2xs text-content-subtle">{row.itemCode}</p>
            ) : null}
          </div>
        ),
      },
      {
        id: "severity",
        header: "Severity",
        accessor: (g) => g.severity,
        width: 110,
        cell: ({ row }) => (
          <Badge
            tone={
              row.severity === "critical"
                ? "danger"
                : row.severity === "high"
                  ? "warning"
                  : row.severity === "medium"
                    ? "info"
                    : "neutral"
            }
            size="xs"
          >
            {titleCase(row.severity)}
          </Badge>
        ),
      },
      {
        id: "coverage",
        header: "Coverage",
        accessor: (g) => g.included,
        width: 170,
        cell: ({ row }) => (
          <span className="tabular-nums text-meta">
            {row.included} in · {row.excluded} out · {row.unclear} unclear ·{" "}
            {row.unanswered} silent
          </span>
        ),
      },
      {
        id: "uncovered",
        header: "Uncovered by",
        accessor: (g) => g.uncoveredVendorIds.length,
        width: 200,
        cell: ({ row }) =>
          row.uncoveredVendorIds.length === 0 ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <span className="text-meta">
              {row.uncoveredVendorIds.map((v) => names.get(v) ?? v).join(", ")}
            </span>
          ),
      },
      {
        id: "exposure",
        header: "Exposure",
        accessor: (g) => g.exposure,
        width: 130,
        align: "right",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.exposure === null ? (
              <span className="italic text-content-subtle">not estimated</span>
            ) : (
              money(row.exposure, currency)
            )}
          </span>
        ),
      },
      {
        id: "note",
        header: "What it means",
        accessor: (g) => g.note,
        width: 420,
        cell: ({ row }) => (
          <p className="whitespace-pre-wrap text-2xs leading-snug text-content-muted">{row.note}</p>
        ),
      },
    ],
    [names, currency],
  );

  return (
    <DataTable<ScopeGap>
      tableId="bidding.scope-gaps"
      data={report.gaps}
      columns={columns}
      getRowId={(row) => row.itemId}
      height={360}
      rowHeight={64}
      stickyHeader
      exportFileName="bid-scope-gaps"
      rowTone={(row) => (row.severity === "critical" ? "danger" : undefined)}
      empty={{
        title: "No scope gaps",
        description: "Every scope row is carried by every bidder in contention.",
      }}
    />
  );
}
