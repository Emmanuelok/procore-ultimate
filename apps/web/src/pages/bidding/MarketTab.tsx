/**
 * MARKET — the questions a buyer cannot answer from inside one package.
 *
 *   Coverage    is this tender actually being competed? Six invitations and
 *               two intending bidders is a package with two bidders, and the
 *               moment to find that out is before the deadline.
 *   Pricing     where each bidder sits against the field, built entirely from
 *               prices they submitted to us — the only competitor
 *               intelligence that is both lawful to hold and useful.
 *   Win rate    by client, work type, sector or competitor, refused wherever
 *               there are too few decided bids to call it a rate.
 *   Board       what this company has published to its supply chain. Never
 *               the estimate.
 *   Authority   who may approve an award of what size, in which currency.
 *
 * Every rate here says how many observations it stands on, and refuses rather
 * than rounding a sample of two into a percentage.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Stat,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { IconProcurement, IconTarget, IconVendor, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  Figure,
  LoadError,
  LoadingBlock,
  RefusalPanel,
  dateTime,
  isoDate,
  money,
  num,
  pct,
  titleCase,
  useAction,
  useNames,
  useResource,
  useVendors,
} from "./biddingShared";
import type {
  AwardDelegationList,
  BidBoard,
  CoverageReport,
  PricingReport,
  VendorBidHistory,
  WinRateReport,
} from "./types";

type Section = "coverage" | "pricing" | "winRate" | "board" | "authority";

export default function MarketTab() {
  const [section, setSection] = useState<Section>("coverage");
  return (
    <div className="space-y-4">
      <SegmentedControl
        aria-label="Market section"
        value={section}
        onChange={(v) => setSection(v as Section)}
        options={[
          { value: "coverage", label: "Coverage" },
          { value: "pricing", label: "Market position" },
          { value: "winRate", label: "Win rate" },
          { value: "board", label: "Bid board" },
          { value: "authority", label: "Award authority" },
        ]}
      />
      {section === "coverage" ? <CoverageSection /> : null}
      {section === "pricing" ? <PricingSection /> : null}
      {section === "winRate" ? <WinRateSection /> : null}
      {section === "board" ? <BoardSection /> : null}
      {section === "authority" ? <AuthoritySection /> : null}
    </div>
  );
}

/* ================================================================== */
/* Coverage                                                            */
/* ================================================================== */

function CoverageSection() {
  const report = useResource<CoverageReport>("/api/v1/companies/current/bid-coverage");
  if (report.loading && !report.data) return <LoadingBlock rows={4} />;
  if (report.error) return <LoadError message={report.error} onRetry={report.reload} />;
  const data = report.data;

  return (
    <Card>
      <CardHeader
        title="Bid coverage"
        subtitle="Coverage counts intentions, not invitations."
        actions={
          data && data.atRisk > 0 ? (
            <Badge tone="danger" size="sm" icon={IconWarning}>
              {data.atRisk} at risk
            </Badge>
          ) : null
        }
      />
      <CardBody flush>
        {!data || data.packages.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={IconProcurement}
              title="Nothing is out to market"
              hint={data?.note ?? "Coverage describes live packages only."}
            />
          </div>
        ) : (
          <>
            <div className="grid gap-4 p-3 sm:grid-cols-4">
              <Stat label="Live tenders" value={String(data.total)} />
              <Stat label="At risk" value={String(data.atRisk)} />
              <Stat
                label="Invited"
                value={String(data.packages.reduce((s, p) => s + p.invited, 0))}
              />
              <Stat
                label="Intending to bid"
                value={String(data.packages.reduce((s, p) => s + p.intending, 0))}
              />
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Package</Th>
                  <Th>Trade</Th>
                  <Th align="right">Invited</Th>
                  <Th align="right">Intending</Th>
                  <Th align="right">Submitted</Th>
                  <Th align="right">Declined</Th>
                  <Th>Due</Th>
                  <Th>Coverage</Th>
                </tr>
              </thead>
              <tbody>
                {data.packages.map((p) => (
                  <tr key={p.packageId}>
                    <Td>
                      <p className="font-medium">{p.reference}</p>
                      <p className="text-2xs text-content-subtle">{p.title}</p>
                    </Td>
                    <Td>{p.tradeCode ?? "—"}</Td>
                    <Td align="right" className="tabular-nums">
                      {p.invited}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {p.intending}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {p.submitted}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {p.declined}
                    </Td>
                    <Td>
                      <p className="text-meta">{dateTime(p.bidDueAt)}</p>
                      {p.daysToDue !== null ? (
                        <p className="text-2xs text-content-subtle">
                          {p.daysToDue < 0 ? "overdue" : `in ${p.daysToDue} day(s)`}
                        </p>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          p.coverageFlag === "critical"
                            ? "danger"
                            : p.coverageFlag === "warning"
                              ? "warning"
                              : "success"
                        }
                        size="xs"
                        dot
                      >
                        {titleCase(p.coverageFlag)}
                      </Badge>
                      <p className="mt-0.5 max-w-md text-2xs leading-snug text-content-muted">
                        {p.note}
                      </p>
                      {p.declineReasons.length > 0 ? (
                        <p className="mt-1 text-2xs text-content-subtle">
                          Declines:{" "}
                          {p.declineReasons
                            .map((d) => `${titleCase(d.reason)} (${d.count})`)
                            .join(", ")}
                        </p>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="border-t border-border p-3 text-2xs leading-relaxed text-content-muted">
              {data.note}
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* Market position                                                     */
/* ================================================================== */

function PricingSection() {
  const [trade, setTrade] = useState("");
  const [vendorId, setVendorId] = useState("");
  const report = useResource<PricingReport>(
    `/api/v1/companies/current/bid-pricing${trade ? `?tradeCode=${encodeURIComponent(trade)}` : ""}`,
  );
  const history = useResource<VendorBidHistory>(
    vendorId ? `/api/v1/companies/current/vendors/${vendorId}/bid-history` : null,
  );
  const vendors = useVendors();

  if (report.loading && !report.data) return <LoadingBlock rows={4} />;
  if (report.error) return <LoadError message={report.error} onRetry={report.reload} />;
  const data = report.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Where the market prices us"
          subtitle={`Built from bids submitted to this company over the last ${data?.windowMonths ?? 24} months.`}
          actions={
            <Input
              placeholder="Filter by trade code"
              value={trade}
              onChange={(e) => setTrade(e.target.value)}
              className="w-56"
            />
          }
        />
        <CardBody flush>
          {!data || data.observations === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No priced field to measure against"
                hint={data?.note ?? "A package needs a field of priced bids before anybody can be placed against it."}
              />
            </div>
          ) : (
            <>
              <div className="grid gap-4 p-3 sm:grid-cols-3">
                <Stat label="Packages examined" value={String(data.packagesExamined)} />
                <Stat label="Priced observations" value={String(data.observations)} />
                <Stat label="Bidders" value={String(data.vendors.length)} />
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>Bidder</Th>
                    <Th align="right">Appearances</Th>
                    <Th align="right">Wins</Th>
                    <Th align="right">Win rate</Th>
                    <Th align="right">Avg rank</Th>
                    <Th align="right">vs field median</Th>
                    <Th>Reading</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.vendors.map((v) => (
                    <tr key={v.vendorId}>
                      <Td>
                        <button
                          type="button"
                          className="text-left font-medium underline-offset-2 hover:underline"
                          onClick={() => setVendorId(v.vendorId)}
                        >
                          {v.vendorName ?? v.vendorId}
                        </button>
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {v.appearances}
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {v.wins}
                      </Td>
                      <Td align="right">
                        <Figure
                          figure={v.winRatePercent}
                          className="block text-right"
                          showReasons={false}
                          render={(x) => <span className="tabular-nums">{pct(x, 0)}</span>}
                        />
                      </Td>
                      <Td align="right">
                        <Figure
                          figure={v.averageRank}
                          className="block text-right"
                          showReasons={false}
                          render={(x) => <span className="tabular-nums">{num(x, 1)}</span>}
                        />
                      </Td>
                      <Td align="right">
                        <Figure
                          figure={v.medianDeviationPercent}
                          className="block text-right"
                          showReasons={false}
                          render={(x) => <span className="tabular-nums">{pct(x, 1)}</span>}
                        />
                      </Td>
                      <Td>
                        <p className="max-w-md text-2xs leading-snug text-content-muted">
                          {v.note}
                        </p>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {data.trades.length > 0 ? (
                <div className="space-y-2 border-t border-border p-3">
                  {data.trades.map((t) => (
                    <div key={t.tradeCode ?? "untraded"} className="text-meta">
                      <span className="font-medium">{t.tradeCode ?? "No trade code"}</span>{" "}
                      <span className="text-content-subtle">
                        · {t.packages} package(s), {t.bidders} bidder(s)
                      </span>
                      <p className="mt-0.5 text-2xs leading-snug text-content-muted">{t.note}</p>
                    </div>
                  ))}
                </div>
              ) : null}
              <p className="border-t border-border p-3 text-2xs leading-relaxed text-content-muted">
                {data.note}
              </p>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="One supplier's history with us"
          subtitle="What they were invited to, what they bid, where they came and how often they say no."
          actions={
            <Select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              className="w-64"
            >
              <option value="">Choose a supplier</option>
              {(vendors.data?.items ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          }
        />
        <CardBody flush>
          {!vendorId ? (
            <div className="p-4">
              <EmptyState
                icon={IconVendor}
                title="Choose a supplier"
                hint="Their whole bidding record with this company, in one place."
              />
            </div>
          ) : history.loading && !history.data ? (
            <div className="p-4">
              <LoadingBlock rows={3} />
            </div>
          ) : history.error ? (
            <div className="p-4">
              <LoadError message={history.error} onRetry={history.reload} />
            </div>
          ) : history.data ? (
            <VendorHistoryPanel data={history.data} />
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}

function VendorHistoryPanel({ data }: { data: VendorBidHistory }) {
  return (
    <>
      <div className="grid gap-4 p-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Invitations" value={String(data.summary.invitations)} />
        <Stat label="Bids submitted" value={String(data.summary.submitted)} />
        <div>
          <div className="text-label uppercase text-content-subtle">Win rate</div>
          <Figure
            figure={data.summary.winRatePercent}
            className="mt-0.5 block text-base font-semibold tabular-nums"
            render={(v) => <>{pct(v, 0)}</>}
          />
        </div>
        <div>
          <div className="text-label uppercase text-content-subtle">Response rate</div>
          <Figure
            figure={data.summary.responseRatePercent}
            className="mt-0.5 block text-base font-semibold tabular-nums"
            render={(v) => <>{pct(v, 0)}</>}
          />
        </div>
        <div>
          <div className="text-label uppercase text-content-subtle">vs field median</div>
          <Figure
            figure={data.summary.medianDeviationFromFieldPercent}
            className="mt-0.5 block text-base font-semibold tabular-nums"
            render={(v) => <>{pct(v, 1)}</>}
          />
        </div>
      </div>
      {data.prequalification ? (
        <Alert
          tone={data.prequalification.state === "approved" ? "success" : "warning"}
          className="mx-3 mb-3"
        >
          <p className="whitespace-pre-wrap">{data.prequalification.note}</p>
        </Alert>
      ) : null}
      <Table>
        <thead>
          <tr>
            <Th>Package</Th>
            <Th>Invited</Th>
            <Th>Outcome</Th>
            <Th align="right">Their bid</Th>
            <Th align="right">vs median</Th>
            <Th align="right">Rank</Th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.packageId}>
              <Td>
                <p className="font-medium">{r.packageReference ?? r.packageId}</p>
                <p className="text-2xs text-content-subtle">{r.packageTitle}</p>
              </Td>
              <Td>
                <p className="text-meta">{isoDate(r.invitedAt)}</p>
                <p className="text-2xs text-content-subtle">{titleCase(r.invitationStatus)}</p>
              </Td>
              <Td>
                {r.won ? (
                  <Badge tone="success" size="xs">
                    Won
                  </Badge>
                ) : r.submitted ? (
                  <Badge tone="neutral" size="xs" variant="subtle">
                    {titleCase(r.submissionStatus ?? "bid")}
                  </Badge>
                ) : r.declineReason ? (
                  <Badge tone="warning" size="xs" variant="subtle">
                    {titleCase(r.declineReason)}
                  </Badge>
                ) : (
                  <span className="text-2xs text-content-subtle">no response</span>
                )}
                {r.onTime === false ? (
                  <p className="text-2xs text-danger-fg">late</p>
                ) : null}
              </Td>
              <Td align="right" className="tabular-nums">
                {r.amount === null || r.currency === null ? "—" : money(r.amount, r.currency)}
              </Td>
              <Td align="right" className="tabular-nums">
                {r.deviationFromMedianPercent === null
                  ? "—"
                  : pct(r.deviationFromMedianPercent, 1)}
              </Td>
              <Td align="right" className="tabular-nums">
                {r.rank === null ? "—" : `${r.rank} of ${r.fieldSize}`}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="border-t border-border p-3 text-2xs leading-relaxed text-content-muted">
        {data.note}
      </p>
    </>
  );
}

/* ================================================================== */
/* Win rate                                                            */
/* ================================================================== */

function WinRateSection() {
  const [by, setBy] = useState("client");
  const report = useResource<WinRateReport>(`/api/v1/companies/current/win-rate?by=${by}`);
  if (report.loading && !report.data) return <LoadingBlock rows={4} />;
  if (report.error) return <LoadError message={report.error} onRetry={report.reload} />;
  const data = report.data;

  return (
    <Card>
      <CardHeader
        title="Win rate"
        subtitle="Over decided pursuits only. Value is bucketed per currency and never summed across one."
        actions={
          <Select value={by} onChange={(e) => setBy(e.target.value)} className="w-48">
            <option value="client">By client</option>
            <option value="workType">By work type</option>
            <option value="sector">By sector</option>
            <option value="source">By source</option>
            <option value="region">By region</option>
            <option value="competitor">By winning competitor</option>
          </Select>
        }
      />
      <CardBody flush>
        {!data || data.groups.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={IconTarget}
              title="No decided pursuits yet"
              hint={data?.note ?? "A win rate is a property of recorded outcomes."}
            />
          </div>
        ) : (
          <>
            <div className="grid gap-4 p-3 sm:grid-cols-4">
              <Stat label="Wins" value={String(data.overall.wins)} />
              <Stat label="Losses" value={String(data.overall.losses)} />
              <div>
                <div className="text-label uppercase text-content-subtle">Overall win rate</div>
                <Figure
                  figure={data.overall.winRatePercent}
                  className="mt-0.5 block text-base font-semibold tabular-nums"
                  render={(v) => <>{pct(v, 1)}</>}
                />
              </div>
              <Stat
                label="Model sample"
                value={String(data.modelSampleSize)}
                hint="decided bids the win model can be fitted on"
              />
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>{titleCase(data.by)}</Th>
                  <Th align="right">Bids</Th>
                  <Th align="right">Won</Th>
                  <Th align="right">Lost</Th>
                  <Th align="right">Win rate</Th>
                  <Th>By value</Th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((g) => (
                  <tr key={g.key}>
                    <Td>{g.label}</Td>
                    <Td align="right" className="tabular-nums">
                      {g.bids}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {g.wins}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {g.losses}
                    </Td>
                    <Td align="right">
                      <Figure
                        figure={g.winRatePercent}
                        className="block text-right"
                        render={(v) => <span className="tabular-nums">{pct(v, 0)}</span>}
                        reasonClassName="max-w-xs"
                      />
                    </Td>
                    <Td>
                      {g.valueByCurrency.length === 0 ? (
                        <span className="text-content-subtle">—</span>
                      ) : (
                        <div className="space-y-0.5">
                          {g.valueByCurrency.map((v) => (
                            <p key={v.currency} className="text-2xs tabular-nums">
                              {money(v.wonValue, v.currency)} of {money(v.bidValue, v.currency)}
                              {v.winRateByValuePercent !== null
                                ? ` (${pct(v.winRateByValuePercent, 0)})`
                                : ""}
                            </p>
                          ))}
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="border-t border-border p-3 text-2xs leading-relaxed text-content-muted">
              {data.note}
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* Bid board                                                           */
/* ================================================================== */

function BoardSection() {
  const board = useResource<BidBoard>("/api/v1/companies/current/bid-board");
  if (board.loading && !board.data) return <LoadingBlock rows={3} />;
  if (board.error) return <LoadError message={board.error} onRetry={board.reload} />;
  const data = board.data;

  return (
    <Card>
      <CardHeader
        title="Bid board"
        subtitle="What this company has published to its supply chain. Never the estimate, never the other bidders."
      />
      <CardBody flush>
        {!data || data.items.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={IconProcurement}
              title="Nothing published"
              hint="Publishing a package is how a supply chain finds out work exists without being on a list somebody drew up years ago."
            />
          </div>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Package</Th>
                  <Th>Trade</Th>
                  <Th>Route</Th>
                  <Th>Closes</Th>
                  <Th>Requirements</Th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      <p className="font-medium">{p.reference}</p>
                      <p className="text-2xs text-content-subtle">{p.title}</p>
                      {p.summary ? (
                        <p className="mt-0.5 max-w-lg text-2xs leading-snug text-content-muted">
                          {p.summary}
                        </p>
                      ) : null}
                    </Td>
                    <Td>{p.tradeCode ?? "—"}</Td>
                    <Td>{titleCase(p.procurementRoute)}</Td>
                    <Td>
                      <p className="text-meta">{dateTime(p.bidDueAt)}</p>
                      {p.hoursToClose !== null ? (
                        <p className="text-2xs text-content-subtle">
                          {p.hoursToClose < 0
                            ? "closed"
                            : `${num(p.hoursToClose / 24, 1)} day(s) left`}
                        </p>
                      ) : null}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {p.prequalificationRequired ? (
                          <Badge tone="warning" size="xs" variant="subtle">
                            Prequalification
                          </Badge>
                        ) : null}
                        {p.isSiteVisitMandatory ? (
                          <Badge tone="info" size="xs" variant="subtle">
                            Mandatory site visit
                          </Badge>
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="border-t border-border p-3 text-2xs leading-relaxed text-content-muted">
              {data.note}
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* Delegated authority                                                 */
/* ================================================================== */

function AuthoritySection() {
  const [version, setVersion] = useState(0);
  const list = useResource<AwardDelegationList>(
    `/api/v1/companies/current/award-delegations?_v=${version}`,
  );
  const action = useAction();
  const names = useNames();
  const [creating, setCreating] = useState(false);

  if (list.loading && !list.data) return <LoadingBlock rows={3} />;
  if (list.error) return <LoadError message={list.error} onRetry={list.reload} />;
  const data = list.data;

  return (
    <Card>
      <CardHeader
        title="Delegated award authority"
        subtitle="An approval limit is only a control if the platform refuses the approval that exceeds it."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            Record a delegation
          </Button>
        }
      />
      <CardBody flush>
        {action.refusal ? (
          <div className="p-3">
            <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
          </div>
        ) : null}
        {!data || data.items.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="No scheme of delegation recorded"
              hint={
                data?.note ??
                "Awards are approved by anyone who is not the recommender, and the absence of a limit is stated on each approval rather than a limit being invented."
              }
            />
          </div>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Holder</Th>
                  <Th>Scope</Th>
                  <Th align="right">Limit</Th>
                  <Th>Valid</Th>
                  <Th>Basis</Th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((d) => (
                  <tr key={d.id}>
                    <Td>
                      <p className="font-medium">
                        {d.subjectKind === "user" ? names(d.subjectId) : titleCase(d.subjectId)}
                      </p>
                      <p className="text-2xs text-content-subtle">
                        {d.label ?? titleCase(d.subjectKind)}
                      </p>
                    </Td>
                    <Td>
                      <span className="text-meta">
                        {d.projectId ? "One project" : "Company-wide"}
                        {d.packageKind ? ` · ${titleCase(d.packageKind)}` : ""}
                      </span>
                    </Td>
                    <Td align="right" className="tabular-nums font-medium">
                      {money(d.maxAwardAmount, d.currency)}
                    </Td>
                    <Td>
                      <span className="text-2xs text-content-subtle">
                        {d.validFrom ? isoDate(d.validFrom) : "—"} →{" "}
                        {d.validTo ? isoDate(d.validTo) : "open"}
                      </span>
                      {!d.isActive ? (
                        <Badge tone="neutral" size="xs" variant="subtle" className="ml-1">
                          Inactive
                        </Badge>
                      ) : null}
                    </Td>
                    <Td>
                      <p className="max-w-md text-2xs leading-snug text-content-muted">
                        {d.basis ?? "—"}
                      </p>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="border-t border-border p-3 text-2xs leading-relaxed text-content-muted">
              {data.note}
            </p>
          </>
        )}
      </CardBody>

      <DelegationModal
        open={creating}
        onClose={() => setCreating(false)}
        action={action}
        onDone={() => {
          setCreating(false);
          setVersion((n) => n + 1);
        }}
      />
    </Card>
  );
}

function DelegationModal({
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
  const users = useResource<{ items: Array<{ id: string; name: string; email: string }> }>(
    "/api/v1/company/users?page=1&pageSize=200",
  );
  const [subjectKind, setSubjectKind] = useState("user");
  const [subjectId, setSubjectId] = useState("");
  const [label, setLabel] = useState("");
  const [maxAwardAmount, setMaxAwardAmount] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const [basis, setBasis] = useState("");

  async function submit() {
    const res = await action.run("delegation", () =>
      api.post("/api/v1/companies/current/award-delegations", {
        subjectKind,
        subjectId,
        label: label || null,
        maxAwardAmount: Number(maxAwardAmount),
        currency,
        basis: basis || null,
      }),
    );
    if (!res) return;
    setSubjectId("");
    setMaxAwardAmount("");
    onDone();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a delegation"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!subjectId || !maxAwardAmount}
            loading={action.busy === "delegation"}
            onClick={() => void submit()}
          >
            Record
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Held by">
            <Select value={subjectKind} onChange={(e) => setSubjectKind(e.target.value)}>
              <option value="user">A named person</option>
              <option value="company_role">A company role</option>
            </Select>
          </Field>
          {subjectKind === "user" ? (
            <Field label="Person" required>
              <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">Choose</option>
                {(users.data?.items ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name || u.email}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Role" required>
              <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">Choose</option>
                {["owner", "admin", "member"].map((r) => (
                  <option key={r} value={r}>
                    {titleCase(r)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Limit" required>
            <Input
              type="number"
              value={maxAwardAmount}
              onChange={(e) => setMaxAwardAmount(e.target.value)}
            />
          </Field>
          <Field
            label="Currency"
            required
            hint="Limits are never converted between currencies here."
          >
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Label">
            <Input
              value={label}
              placeholder="Commercial Manager"
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Basis" hint="The board minute or policy this delegation comes from.">
          <Textarea rows={2} value={basis} onChange={(e) => setBasis(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
