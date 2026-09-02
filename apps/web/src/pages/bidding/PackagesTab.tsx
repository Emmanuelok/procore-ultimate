/**
 * The tender register, and the lifecycle of one package.
 *
 * The two things this screen refuses to blur:
 *
 *  - The EVALUATION BASIS is frozen at issue. The panel says so, and shows the
 *    declared criteria and weights, because changing them once prices are in
 *    the room is the classic procurement-integrity failure.
 *  - APPROVAL TO TENDER IS NOT BY THE AUTHOR. The API refuses it; this screen
 *    says who wrote the package and who agreed it before it went to market.
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
  Select,
  Textarea,
} from "../../ui";
import type { DataColumns } from "../../ui";
import { IconLock, IconPlus, IconProcurement } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  LoadError,
  LoadingBlock,
  MoneyStat,
  RefusalPanel,
  SealBanner,
  Sealed,
  dateTime,
  isoDate,
  money,
  num,
  packageTone,
  titleCase,
  useAction,
  useNames,
  useReason,
  useResource,
} from "./biddingShared";
import type { BidPackage, PackageDetail, Paginated } from "./types";

const PACKAGE_KINDS = [
  "subcontract",
  "supply_only",
  "supply_and_install",
  "design_and_build",
  "professional_services",
  "plant_hire",
  "labour_only",
  "framework_call_off",
] as const;

const PROCUREMENT_ROUTES = [
  "open_tender",
  "selective_tender",
  "negotiated",
  "framework",
  "single_source",
  "two_stage",
  "competitive_dialogue",
] as const;

const EVALUATION_METHODS = [
  "lowest_price",
  "most_economically_advantageous",
  "quality_price_ratio",
  "best_value",
  "quality_only",
] as const;

export default function PackagesTab({
  projectId,
  selectedId,
  onSelect,
  onMutated,
}: {
  projectId: string;
  selectedId: string;
  onSelect: (packageId: string) => void;
  onMutated: () => void;
}) {
  const [version, setVersion] = useState(0);
  const list = useResource<Paginated<BidPackage>>(
    `/api/v1/projects/${projectId}/bid-packages?page=1&pageSize=200&_v=${version}`,
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  function refresh() {
    setVersion((n) => n + 1);
    onMutated();
  }

  const rows = list.data?.items ?? [];

  const columns: DataColumns<BidPackage> = useMemo(
    () => [
      {
        id: "reference",
        header: "Ref",
        accessor: "reference",
        type: "code",
        width: 110,
        sticky: "start",
      },
      { id: "title", header: "Package", accessor: "title", type: "text", width: 280 },
      {
        id: "kind",
        header: "Kind",
        accessor: (row) => titleCase(row.packageKind),
        type: "text",
        width: 150,
        groupable: true,
      },
      {
        id: "route",
        header: "Route",
        accessor: (row) => titleCase(row.procurementRoute),
        type: "text",
        width: 150,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 150,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={packageTone(row.status)} size="xs" dot variant="subtle">
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "seal",
        header: "Seal",
        accessor: (row) => (row.seal.isSealed ? (row.seal.amountsWithheld ? 2 : 1) : 0),
        width: 140,
        cell: ({ row }) =>
          !row.seal.isSealed ? (
            <span className="text-2xs text-content-subtle">not sealed</span>
          ) : row.seal.amountsWithheld ? (
            <Sealed compact />
          ) : (
            <Badge tone="success" size="xs" variant="subtle">
              opened
            </Badge>
          ),
      },
      {
        id: "estimate",
        header: "Pre-tender estimate",
        accessor: "engineersEstimate",
        type: "currency",
        width: 170,
        cell: ({ row }) =>
          row.engineersEstimate === null ? (
            <span
              className="text-2xs italic text-content-subtle"
              title="Without an estimate there is nothing to measure the market against."
            >
              none recorded
            </span>
          ) : (
            <span className="tabular-nums">{money(row.engineersEstimate, row.currency)}</span>
          ),
      },
      {
        id: "due",
        header: "Bids due",
        accessor: "bidDueAt",
        type: "datetime",
        width: 170,
        cell: ({ row }) =>
          row.bidDueAt ? (
            <span className="tabular-nums">{dateTime(row.bidDueAt)}</span>
          ) : (
            <span className="text-2xs italic text-danger-fg">no deadline set</span>
          ),
      },
      {
        id: "invitations",
        header: "Invited",
        accessor: "invitationCount",
        type: "number",
        width: 90,
        align: "right",
      },
      {
        id: "submissions",
        header: "Bids",
        accessor: "submissionCount",
        type: "number",
        width: 80,
        align: "right",
      },
      {
        id: "declines",
        header: "Declines",
        accessor: "declineCount",
        type: "number",
        width: 90,
        align: "right",
      },
      {
        id: "prequal",
        header: "Prequal",
        accessor: (row) => (row.prequalificationRequired === 1 ? "Required" : "Not required"),
        type: "text",
        width: 130,
        cell: ({ row }) => (
          <Badge
            tone={row.prequalificationRequired === 1 ? "info" : "neutral"}
            size="xs"
            variant="subtle"
          >
            {row.prequalificationRequired === 1
              ? `Required · ${titleCase(row.requirements.prequalification.strictness)}`
              : "Not required"}
          </Badge>
        ),
      },
    ],
    [],
  );

  if (list.loading && rows.length === 0) return <LoadingBlock />;
  if (list.error) return <LoadError message={list.error} onRetry={list.reload} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-meta leading-relaxed text-content-muted">
          A package is the scope, the timetable and the evaluation basis — agreed by somebody other
          than its author before anybody is invited to price it. The basis is frozen at issue.
        </p>
        <Button icon={IconPlus} onClick={() => setCreateOpen(true)}>
          New package
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={IconProcurement}
          title="No bid packages on this project"
          hint="Nothing has been put out to tender here yet. A package carries the scope, the deadline that decides which bids are late, and the basis on which the winner will be chosen — declared before bids open, never after."
          action={
            <Button icon={IconPlus} onClick={() => setCreateOpen(true)}>
              New package
            </Button>
          }
        />
      ) : (
        <DataTable<BidPackage>
          tableId="bidding.packages"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={520}
          stickyHeader
          filterRow
          searchPlaceholder="Search packages…"
          exportFileName="bid-packages"
          onRowClick={({ row }) => setOpenId(row.id)}
          rowTone={(row) => (row.seal.amountsWithheld ? "warning" : undefined)}
          rowClassName={(row) => (row.id === selectedId ? "bg-surface-selected" : undefined)}
          rowActions={(row) => [
            {
              id: "work",
              label: "Work on this package",
              onSelect: () => onSelect(row.id),
            },
            { id: "open", label: "Open detail", onSelect: () => setOpenId(row.id) },
          ]}
          empty={{
            title: "No packages match",
            description: "Every package on this project is filtered out by the current filters.",
          }}
        />
      )}

      <PackageDrawer
        projectId={projectId}
        packageId={openId}
        onClose={() => setOpenId(null)}
        onMutated={refresh}
        onWorkOn={(id) => {
          setOpenId(null);
          onSelect(id);
        }}
      />

      <CreatePackageModal
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false);
          refresh();
          setOpenId(id);
        }}
      />
    </div>
  );
}

/* ================================================================== */
/* Detail drawer                                                       */
/* ================================================================== */

function PackageDrawer({
  projectId,
  packageId,
  onClose,
  onMutated,
  onWorkOn,
}: {
  projectId: string;
  packageId: string | null;
  onClose: () => void;
  onMutated: () => void;
  onWorkOn: (id: string) => void;
}) {
  const detail = useResource<PackageDetail>(
    packageId ? `/api/v1/projects/${projectId}/bid-packages/${packageId}` : null,
  );
  const action = useAction();
  const { ask, dialog } = useReason();
  const nameOf = useNames();
  const pkg = detail.data;

  async function lifecycle(kind: "approve" | "issue" | "close") {
    if (!packageId) return;
    const done = await action.run(kind, () =>
      api.post(`/api/v1/projects/${projectId}/bid-packages/${packageId}/${kind}`, {}),
    );
    if (done) {
      detail.reload();
      onMutated();
    }
  }

  async function cancel() {
    if (!packageId) return;
    const reason = await ask({
      title: "Cancel this tender",
      description:
        "Every invited bidder has spent money pricing this. The reason is recorded on the package and in the ledger, and is what they are owed.",
      confirmLabel: "Cancel the tender",
      destructive: true,
    });
    if (!reason) return;
    const done = await action.run("cancel", () =>
      api.post(`/api/v1/projects/${projectId}/bid-packages/${packageId}/cancel`, { reason }),
    );
    if (done) {
      detail.reload();
      onMutated();
    }
  }

  return (
    <>
      <Drawer
        open={packageId !== null}
        onClose={onClose}
        size="xl"
        title={pkg ? `${pkg.reference} — ${pkg.title}` : "Bid package"}
        description={pkg ? titleCase(pkg.packageKind) : undefined}
        footer={
          pkg ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button variant="secondary" onClick={() => onWorkOn(pkg.id)}>
                Work on this package
              </Button>
              {!pkg.approvedBy ? (
                <Button
                  onClick={() => void lifecycle("approve")}
                  loading={action.busy === "approve"}
                >
                  Approve for tender
                </Button>
              ) : !pkg.issuedAt ? (
                <Button onClick={() => void lifecycle("issue")} loading={action.busy === "issue"}>
                  Issue to market
                </Button>
              ) : pkg.status !== "closed" && pkg.status !== "awarded" ? (
                <Button
                  variant="secondary"
                  onClick={() => void lifecycle("close")}
                  loading={action.busy === "close"}
                >
                  Close to bids
                </Button>
              ) : null}
              {pkg.status !== "awarded" && pkg.status !== "cancelled" ? (
                <Button variant="danger" onClick={() => void cancel()} loading={action.busy === "cancel"}>
                  Cancel
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {detail.loading && !pkg ? (
          <LoadingBlock rows={4} />
        ) : detail.error ? (
          <LoadError message={detail.error} onRetry={detail.reload} />
        ) : pkg ? (
          <div className="space-y-4">
            <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

            <SealBanner seal={pkg.seal} />

            <div className="grid gap-3 sm:grid-cols-3">
              <Card>
                <CardBody>
                  <MoneyStat
                    label="Pre-tender estimate"
                    value={pkg.engineersEstimate}
                    currency={pkg.currency}
                    hint={
                      pkg.engineersEstimate === null
                        ? "Nothing to measure the market against."
                        : "What we thought this was worth before bids."
                    }
                  />
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <div className="text-label uppercase text-content-subtle">Lowest bid</div>
                  <div className="mt-0.5 text-base font-semibold tabular-nums">
                    {pkg.seal.amountsWithheld ? (
                      <Sealed />
                    ) : pkg.market.lowest.value === null ? (
                      <span className="text-sm font-normal italic text-content-subtle">
                        not available
                      </span>
                    ) : (
                      money(pkg.market.lowest.value, pkg.currency)
                    )}
                  </div>
                  {!pkg.seal.amountsWithheld && pkg.market.lowest.reasons.length > 0 ? (
                    <p className="mt-1 text-2xs leading-snug text-content-subtle">
                      {pkg.market.lowest.reasons.join(" ")}
                    </p>
                  ) : null}
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <div className="text-label uppercase text-content-subtle">
                    Against the estimate
                  </div>
                  <div className="mt-0.5 text-base font-semibold tabular-nums">
                    {pkg.seal.amountsWithheld ? (
                      <Sealed />
                    ) : pkg.market.againstEstimatePercent.value === null ? (
                      <span className="text-sm font-normal italic text-content-subtle">
                        not available
                      </span>
                    ) : (
                      `${num(pkg.market.againstEstimatePercent.value, 1)}%`
                    )}
                  </div>
                  {!pkg.seal.amountsWithheld &&
                  pkg.market.againstEstimatePercent.reasons.length > 0 ? (
                    <p className="mt-1 text-2xs leading-snug text-content-subtle">
                      {pkg.market.againstEstimatePercent.reasons.join(" ")}
                    </p>
                  ) : null}
                </CardBody>
              </Card>
            </div>

            <section>
              <h3 className="text-label uppercase text-content-subtle">The tender timetable</h3>
              <DescriptionList
                className="mt-2"
                columns={2}
                size="sm"
                items={[
                  { label: "Issued", value: dateTime(pkg.timetable.issuedAt) },
                  {
                    label: "Questions due",
                    value: dateTime(pkg.timetable.questionsDueAt),
                    hint:
                      pkg.timetable.questionsClosed === null
                        ? "No question deadline set."
                        : pkg.timetable.questionsClosed
                          ? "Closed."
                          : "Still open.",
                  },
                  {
                    label: "Bids due",
                    value: dateTime(pkg.timetable.bidDueAt),
                    tone: pkg.timetable.bidDueAt ? undefined : "danger",
                    hint: pkg.timetable.bidDueAt
                      ? pkg.timetable.hoursToBidDue !== null && pkg.timetable.hoursToBidDue > 0
                        ? `${num(pkg.timetable.hoursToBidDue, 1)} hours to go.`
                        : "Closed — lateness is measured from this instant."
                      : "A tender with no deadline has no late bids, and no fair ones either.",
                  },
                  {
                    label: "Bid validity",
                    value:
                      pkg.timetable.bidValidityDays === null
                        ? "not stated"
                        : `${pkg.timetable.bidValidityDays} days`,
                  },
                  {
                    label: "Site visit",
                    value: dateTime(pkg.timetable.siteVisitAt),
                    hint: pkg.timetable.isSiteVisitMandatory ? "Mandatory." : "Not mandatory.",
                  },
                  {
                    label: "Anticipated award",
                    value: isoDate(pkg.timetable.anticipatedAwardDate),
                  },
                ]}
              />
            </section>

            <section>
              <h3 className="text-label uppercase text-content-subtle">
                The evaluation basis — frozen at issue
              </h3>
              <Alert tone="info" variant="subtle" size="sm" className="mt-2">
                Method <strong>{titleCase(pkg.evaluationMethod)}</strong>
                {pkg.priceWeight !== null && pkg.qualityWeight !== null
                  ? `, weighted ${num(pkg.priceWeight, 0)}% price / ${num(pkg.qualityWeight, 0)}% quality.`
                  : ". No price/quality weighting is declared, so no combined score can be formed."}{" "}
                Once bidders can see the package, none of this may change: changing the basis when
                the prices are in the room is the classic procurement-integrity failure, and the
                API refuses it rather than warning about it.
              </Alert>
              {pkg.evaluationCriteria.length === 0 ? (
                <p className="mt-2 text-meta text-content-subtle">
                  No evaluation criteria are declared. Bids on this package cannot be scored on
                  quality — only price will decide it.
                </p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {pkg.evaluationCriteria.map((c) => (
                    <li
                      key={c.key}
                      className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface-raised p-2"
                    >
                      <div className="min-w-0">
                        <p className="text-meta font-medium">{c.label}</p>
                        <p className="text-2xs text-content-subtle">
                          <code className="font-mono">{c.key}</code> · {titleCase(c.kind)}
                        </p>
                        {c.guidance ? (
                          <p className="mt-0.5 text-2xs text-content-muted">{c.guidance}</p>
                        ) : null}
                      </div>
                      <Badge tone={c.weight > 0 ? "info" : "warning"} size="xs">
                        weight {num(c.weight, 0)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="text-label uppercase text-content-subtle">Control record</h3>
              <DescriptionList
                className="mt-2"
                columns={2}
                size="sm"
                items={[
                  { label: "Written by", value: nameOf(pkg.createdBy) },
                  {
                    label: "Approved for tender by",
                    value: pkg.approvedBy ? nameOf(pkg.approvedBy) : "not approved",
                    hint: pkg.approvedBy
                      ? `${dateTime(pkg.approvedAt)} — and never the author.`
                      : "Somebody other than the author has to agree the scope, timetable and basis before it goes to market.",
                    tone: pkg.approvedBy ? "success" : "warning",
                  },
                  {
                    label: "Prequalification",
                    value: pkg.requirements.prequalification.required
                      ? `Required — ${titleCase(pkg.requirements.prequalification.strictness)} at award`
                      : "Not required",
                    span: 2,
                    hint: pkg.requirements.prequalification.required
                      ? pkg.requirements.prequalification.strictness === "refuse"
                        ? "Awarding to a vendor whose prequalification has lapsed is refused."
                        : "Awarding to a lapsed vendor is permitted but the lapse is named on the record."
                      : undefined,
                  },
                  {
                    label: "Bonds required",
                    value:
                      pkg.requirements.bonds.length === 0
                        ? "none recorded"
                        : pkg.requirements.bonds
                            .map(
                              (b) =>
                                `${titleCase(b.bondType)}${b.percent ? ` ${num(b.percent, 0)}%` : ""}`,
                            )
                            .join(", "),
                  },
                  {
                    label: "Insurance required",
                    value:
                      pkg.requirements.insurance.length === 0
                        ? "none recorded"
                        : pkg.requirements.insurance
                            .map((i) => titleCase(i.policyType))
                            .join(", "),
                  },
                ]}
              />
            </section>

            {pkg.addenda.length > 0 ? (
              <section>
                <h3 className="text-label uppercase text-content-subtle">
                  Addenda — every one changed the question the bidders are answering
                </h3>
                <ul className="mt-2 space-y-2">
                  {pkg.addenda.map((a) => (
                    <li key={a.reference} className="rounded-md border border-border p-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-meta font-semibold">{a.reference}</span>
                        <span className="text-2xs text-content-subtle">
                          {dateTime(a.issuedAt)} by {nameOf(a.issuedBy)}
                        </span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-meta text-content-muted">
                        {a.description}
                      </p>
                      {a.newBidDueAt ? (
                        <p className="mt-1 text-2xs text-content-subtle">
                          Deadline moved from {dateTime(a.previousBidDueAt)} to{" "}
                          {dateTime(a.newBidDueAt)}.
                        </p>
                      ) : (
                        <p className="mt-1 text-2xs text-warning-fg">
                          No extension was given with this addendum.
                        </p>
                      )}
                      {a.outstandingFrom && a.outstandingFrom.length > 0 ? (
                        <p className="mt-1 text-2xs text-warning-fg">
                          {a.outstandingFrom.length} invited bidder
                          {a.outstandingFrom.length === 1 ? " has" : "s have"} not acknowledged it —
                          a bid submitted without acknowledging an addendum was priced against a
                          different scope.
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {pkg.cancelledReason ? (
              <Alert tone="danger" title="Cancelled">
                {pkg.cancelledReason}
              </Alert>
            ) : null}
          </div>
        ) : null}
      </Drawer>
      {dialog}
    </>
  );
}

/* ================================================================== */
/* Create                                                              */
/* ================================================================== */

function CreatePackageModal({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const action = useAction();
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState("");
  const [kind, setKind] = useState<string>("subcontract");
  const [route, setRoute] = useState<string>("selective_tender");
  const [currency, setCurrency] = useState("USD");
  const [estimate, setEstimate] = useState("");
  const [bidDueAt, setBidDueAt] = useState("");
  const [method, setMethod] = useState<string>("lowest_price");
  const [sealed, setSealed] = useState(true);
  const [witness, setWitness] = useState(true);
  const [prequal, setPrequal] = useState(true);
  const [strictness, setStrictness] = useState<"refuse" | "warn">("refuse");

  async function submit() {
    const body: Record<string, unknown> = {
      title: title.trim(),
      packageKind: kind,
      procurementRoute: route,
      currency: currency.trim().toUpperCase(),
      evaluationMethod: method,
      isSealed: sealed,
      requiresOpeningWitness: witness,
      prequalificationRequired: prequal,
      prequalificationStrictness: strictness,
    };
    if (scope.trim()) body["scopeDescription"] = scope.trim();
    if (estimate.trim()) body["engineersEstimate"] = Number(estimate);
    if (bidDueAt) body["bidDueAt"] = new Date(bidDueAt).toISOString();
    const created = await action.run("create", () =>
      api.post<{ id: string }>(`/api/v1/projects/${projectId}/bid-packages`, body),
    );
    if (created) onCreated(created.id);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New bid package"
      size="lg"
      description="The scope, the timetable and the basis on which the winner will be chosen."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={action.busy === "create"}
            disabled={title.trim().length === 0}
          >
            Create package
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        <Field label="Title" required>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Structural steelwork — frame and metal deck"
          />
        </Field>
        <Field label="Scope" hint="What the bidders are pricing.">
          <Textarea rows={3} value={scope} onChange={(e) => setScope(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {PACKAGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {titleCase(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Procurement route">
            <Select value={route} onChange={(e) => setRoute(e.target.value)}>
              {PROCUREMENT_ROUTES.map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" hint="Every figure on this package is in this currency.">
            <Input
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              maxLength={8}
              className="w-32"
            />
          </Field>
          <Field
            label="Pre-tender estimate"
            hint="What makes 'everyone is 30% over' visible. Leave blank rather than guess."
            optional
          >
            <Input
              type="number"
              inputMode="decimal"
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
            />
          </Field>
          <Field
            label="Bids due"
            hint="The instant that decides which bids are late. Required before the package can be issued."
          >
            <Input
              type="datetime-local"
              value={bidDueAt}
              onChange={(e) => setBidDueAt(e.target.value)}
            />
          </Field>
          <Field label="Evaluation method" hint="Frozen once the package is issued.">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {EVALUATION_METHODS.map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="rounded-lg border border-border bg-surface-sunken p-3">
          <p className="flex items-center gap-2 text-meta font-semibold">
            <IconLock className="h-4 w-4" aria-hidden />
            The seal
          </p>
          <label className="mt-2 flex items-start gap-2 text-meta">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={sealed}
              onChange={(e) => setSealed(e.target.checked)}
            />
            <span>
              Take sealed bids. While the seal holds, no endpoint on this platform returns a
              submitted amount — not the list, not the levelling grid, not the scoring, not the
              tabulation report.
            </span>
          </label>
          <label className="mt-2 flex items-start gap-2 text-meta">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={witness}
              disabled={!sealed}
              onChange={(e) => setWitness(e.target.checked)}
            />
            <span>
              Require a witness at the opening, who may not be the opener. Waiving this is a
              recorded decision — a sealed bid opened by one person alone has no witness to the
              fact that the prices were not altered between the deadline and the record.
            </span>
          </label>
        </div>

        <div className="rounded-lg border border-border bg-surface-sunken p-3">
          <label className="flex items-start gap-2 text-meta">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={prequal}
              onChange={(e) => setPrequal(e.target.checked)}
            />
            <span>Bidders must be prequalified.</span>
          </label>
          {prequal ? (
            <Field
              className="mt-2"
              label="At award, a lapsed prequalification should"
              hint="Either way the lapse is named on the record."
            >
              <Select
                value={strictness}
                onChange={(e) => setStrictness(e.target.value === "warn" ? "warn" : "refuse")}
                className="max-w-xs"
              >
                <option value="refuse">Refuse the award</option>
                <option value="warn">Warn, and record who accepted the risk</option>
              </Select>
            </Field>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
