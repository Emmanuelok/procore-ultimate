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
  MultiSelect,
  Select,
  Textarea,
} from "../../ui";
import type { DataColumns } from "../../ui";
import { IconEdit, IconLock, IconPlus, IconProcurement } from "../../ui/icons";
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
import type {
  BidPackage,
  BudgetLineOptions,
  EvaluationCriterion,
  PackageDetail,
  Paginated,
} from "./types";

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
  const [editOpen, setEditOpen] = useState(false);
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
              {pkg.status !== "awarded" && pkg.status !== "cancelled" ? (
                <Button
                  variant="secondary"
                  icon={IconEdit}
                  onClick={() => setEditOpen(true)}
                >
                  Edit
                </Button>
              ) : null}
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
      <EditPackageModal
        open={editOpen && pkg !== null}
        projectId={projectId}
        pkg={pkg ?? null}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          detail.reload();
          onMutated();
        }}
      />
      {dialog}
    </>
  );
}
/* ================================================================== */
/* One form, two modals                                                */
/* ================================================================== */

/**
 * THE FIELDS AN AWARD LATER DEPENDS ON.
 *
 * The create modal used to collect eleven fields, and there was no edit
 * screen at all, so four things the API can do could never be done from a
 * browser and three deliverables degraded quietly as a result:
 *
 *  - `tradeCode` keys the coverage report (#158) and the cross-package
 *    detectors (cover bidding, winner rotation). Without it every package
 *    reported "No trade code" and the trade-keyed detectors never keyed on
 *    anything.
 *  - `budgetLineItemIds` decides where an approved award's committed cost
 *    lands. Empty meant `insertSovLine` wrote a line with no budget line and
 *    `syncBudgetCommitted` never ran — the awarded value never reached the
 *    project budget.
 *  - `anticipatedAwardDate` + `bidValidityDays` are the two halves of the
 *    bid-validity control: without them the clock is measured against today
 *    and the "expires before award" warning can never fire.
 *  - the evaluation criteria and their weights were rendered but not
 *    editable, so a weighted evaluation could not be configured.
 *
 * The API freezes the evaluation basis at issue and the estimate/currency
 * once a bid exists. This form mirrors both freezes rather than discovering
 * them in a 409: a frozen field is disabled with the reason next to it.
 */
interface CriterionDraft {
  key: string;
  label: string;
  weight: string;
  kind: "price" | "quality";
}

interface PackageForm {
  title: string;
  scopeDescription: string;
  packageKind: string;
  procurementRoute: string;
  tradeCode: string;
  csiDivision: string;
  currency: string;
  engineersEstimate: string;
  estimatedValue: string;
  questionsDueAt: string;
  bidDueAt: string;
  bidValidityDays: string;
  siteVisitAt: string;
  anticipatedAwardDate: string;
  anticipatedStartDate: string;
  anticipatedCompletionDate: string;
  budgetLineItemIds: string[];
  evaluationMethod: string;
  priceWeight: string;
  qualityWeight: string;
  criteria: CriterionDraft[];
  isSealed: boolean;
  requiresOpeningWitness: boolean;
  prequalificationRequired: boolean;
  prequalificationStrictness: "refuse" | "warn";
  retentionPercent: string;
  paymentTermsDays: string;
}

const EMPTY_FORM: PackageForm = {
  title: "",
  scopeDescription: "",
  packageKind: "subcontract",
  procurementRoute: "selective_tender",
  tradeCode: "",
  csiDivision: "",
  currency: "USD",
  engineersEstimate: "",
  estimatedValue: "",
  questionsDueAt: "",
  bidDueAt: "",
  bidValidityDays: "",
  siteVisitAt: "",
  anticipatedAwardDate: "",
  anticipatedStartDate: "",
  anticipatedCompletionDate: "",
  budgetLineItemIds: [],
  evaluationMethod: "lowest_price",
  priceWeight: "",
  qualityWeight: "",
  criteria: [],
  isSealed: true,
  requiresOpeningWitness: true,
  prequalificationRequired: true,
  prequalificationStrictness: "refuse",
  retentionPercent: "",
  paymentTermsDays: "",
};

/** ISO timestamp → the value a `datetime-local` input expects, in local time. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value.trim()) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formFromPackage(pkg: PackageDetail): PackageForm {
  return {
    title: pkg.title,
    scopeDescription: pkg.scopeDescription ?? "",
    packageKind: pkg.packageKind,
    procurementRoute: pkg.procurementRoute,
    tradeCode: pkg.tradeCode ?? "",
    csiDivision: pkg.csiDivision ?? "",
    currency: pkg.currency,
    engineersEstimate: pkg.engineersEstimate === null ? "" : String(pkg.engineersEstimate),
    estimatedValue: pkg.estimatedValue === null ? "" : String(pkg.estimatedValue),
    questionsDueAt: toLocalInput(pkg.timetable.questionsDueAt),
    bidDueAt: toLocalInput(pkg.bidDueAt),
    bidValidityDays:
      pkg.timetable.bidValidityDays === null ? "" : String(pkg.timetable.bidValidityDays),
    siteVisitAt: toLocalInput(pkg.timetable.siteVisitAt),
    anticipatedAwardDate: pkg.timetable.anticipatedAwardDate ?? "",
    anticipatedStartDate: pkg.timetable.anticipatedStartDate ?? "",
    anticipatedCompletionDate: pkg.timetable.anticipatedCompletionDate ?? "",
    budgetLineItemIds: pkg.budgetLineItemIds ?? [],
    evaluationMethod: pkg.evaluationMethod,
    priceWeight: pkg.priceWeight === null ? "" : String(pkg.priceWeight),
    qualityWeight: pkg.qualityWeight === null ? "" : String(pkg.qualityWeight),
    criteria: (pkg.evaluationCriteria ?? []).map((c) => ({
      key: c.key,
      label: c.label,
      weight: String(c.weight),
      kind: c.kind,
    })),
    isSealed: pkg.isSealed === 1,
    requiresOpeningWitness: pkg.seal.requiresWitness,
    prequalificationRequired: pkg.prequalificationRequired === 1,
    prequalificationStrictness:
      pkg.requirements.prequalification.strictness === "warn" ? "warn" : "refuse",
    retentionPercent:
      pkg.requirements.retentionPercent === null ? "" : String(pkg.requirements.retentionPercent),
    paymentTermsDays:
      pkg.requirements.paymentTermsDays === null ? "" : String(pkg.requirements.paymentTermsDays),
  };
}

/** The criteria rows, as the API wants them, or `null` when none are declared. */
function criteriaBody(form: PackageForm): EvaluationCriterion[] {
  return form.criteria
    .filter((c) => c.key.trim() && c.label.trim())
    .map((c) => ({
      key: c.key.trim(),
      label: c.label.trim(),
      weight: numberOrNull(c.weight) ?? 0,
      kind: c.kind,
    }));
}

/** Everything the create route accepts, with the blank fields left out. */
function createBody(form: PackageForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: form.title.trim(),
    packageKind: form.packageKind,
    procurementRoute: form.procurementRoute,
    currency: form.currency.trim().toUpperCase(),
    evaluationMethod: form.evaluationMethod,
    isSealed: form.isSealed,
    requiresOpeningWitness: form.requiresOpeningWitness,
    prequalificationRequired: form.prequalificationRequired,
    prequalificationStrictness: form.prequalificationStrictness,
  };
  if (form.scopeDescription.trim()) body["scopeDescription"] = form.scopeDescription.trim();
  if (form.tradeCode.trim()) body["tradeCode"] = form.tradeCode.trim();
  if (form.csiDivision.trim()) body["csiDivision"] = form.csiDivision.trim();
  const estimate = numberOrNull(form.engineersEstimate);
  if (estimate !== null) body["engineersEstimate"] = estimate;
  const value = numberOrNull(form.estimatedValue);
  if (value !== null) body["estimatedValue"] = value;
  const questionsDueAt = fromLocalInput(form.questionsDueAt);
  if (questionsDueAt) body["questionsDueAt"] = questionsDueAt;
  const bidDueAt = fromLocalInput(form.bidDueAt);
  if (bidDueAt) body["bidDueAt"] = bidDueAt;
  const validity = numberOrNull(form.bidValidityDays);
  if (validity !== null) body["bidValidityDays"] = validity;
  const siteVisitAt = fromLocalInput(form.siteVisitAt);
  if (siteVisitAt) body["siteVisitAt"] = siteVisitAt;
  if (form.anticipatedAwardDate) body["anticipatedAwardDate"] = form.anticipatedAwardDate;
  if (form.anticipatedStartDate) body["anticipatedStartDate"] = form.anticipatedStartDate;
  if (form.anticipatedCompletionDate) {
    body["anticipatedCompletionDate"] = form.anticipatedCompletionDate;
  }
  if (form.budgetLineItemIds.length > 0) body["budgetLineItemIds"] = form.budgetLineItemIds;
  const priceWeight = numberOrNull(form.priceWeight);
  if (priceWeight !== null) body["priceWeight"] = priceWeight;
  const qualityWeight = numberOrNull(form.qualityWeight);
  if (qualityWeight !== null) body["qualityWeight"] = qualityWeight;
  const criteria = criteriaBody(form);
  if (criteria.length > 0) body["evaluationCriteria"] = criteria;
  const retention = numberOrNull(form.retentionPercent);
  if (retention !== null) body["retentionPercent"] = retention;
  const terms = numberOrNull(form.paymentTermsDays);
  if (terms !== null) body["paymentTermsDays"] = terms;
  return body;
}

/**
 * The PATCH body is a DIFF, not the whole form.
 *
 * The API refuses any request that so much as mentions a frozen field once
 * the package is issued (`body[f] !== undefined` is the test), so sending an
 * unchanged `evaluationMethod` back would be refused for a change nobody
 * made. Only fields whose value actually moved are sent.
 */
function patchBody(form: PackageForm, original: PackageForm): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const put = (key: string, next: unknown, prev: unknown) => {
    if (JSON.stringify(next) !== JSON.stringify(prev)) body[key] = next;
  };
  put("title", form.title.trim(), original.title.trim());
  put(
    "scopeDescription",
    form.scopeDescription.trim() || null,
    original.scopeDescription.trim() || null,
  );
  put("packageKind", form.packageKind, original.packageKind);
  put("procurementRoute", form.procurementRoute, original.procurementRoute);
  put("tradeCode", form.tradeCode.trim() || null, original.tradeCode.trim() || null);
  put("csiDivision", form.csiDivision.trim() || null, original.csiDivision.trim() || null);
  put("currency", form.currency.trim().toUpperCase(), original.currency.trim().toUpperCase());
  put(
    "engineersEstimate",
    numberOrNull(form.engineersEstimate),
    numberOrNull(original.engineersEstimate),
  );
  put("estimatedValue", numberOrNull(form.estimatedValue), numberOrNull(original.estimatedValue));
  put("questionsDueAt", fromLocalInput(form.questionsDueAt), fromLocalInput(original.questionsDueAt));
  put("bidDueAt", fromLocalInput(form.bidDueAt), fromLocalInput(original.bidDueAt));
  put(
    "bidValidityDays",
    numberOrNull(form.bidValidityDays),
    numberOrNull(original.bidValidityDays),
  );
  put("siteVisitAt", fromLocalInput(form.siteVisitAt), fromLocalInput(original.siteVisitAt));
  put(
    "anticipatedAwardDate",
    form.anticipatedAwardDate || null,
    original.anticipatedAwardDate || null,
  );
  put(
    "anticipatedStartDate",
    form.anticipatedStartDate || null,
    original.anticipatedStartDate || null,
  );
  put(
    "anticipatedCompletionDate",
    form.anticipatedCompletionDate || null,
    original.anticipatedCompletionDate || null,
  );
  put("budgetLineItemIds", form.budgetLineItemIds, original.budgetLineItemIds);
  put("evaluationMethod", form.evaluationMethod, original.evaluationMethod);
  put("priceWeight", numberOrNull(form.priceWeight), numberOrNull(original.priceWeight));
  put("qualityWeight", numberOrNull(form.qualityWeight), numberOrNull(original.qualityWeight));
  put("evaluationCriteria", criteriaBody(form), criteriaBody(original));
  put("isSealed", form.isSealed, original.isSealed);
  put("requiresOpeningWitness", form.requiresOpeningWitness, original.requiresOpeningWitness);
  put(
    "prequalificationRequired",
    form.prequalificationRequired,
    original.prequalificationRequired,
  );
  put(
    "prequalificationStrictness",
    form.prequalificationStrictness,
    original.prequalificationStrictness,
  );
  put(
    "retentionPercent",
    numberOrNull(form.retentionPercent),
    numberOrNull(original.retentionPercent),
  );
  put(
    "paymentTermsDays",
    numberOrNull(form.paymentTermsDays),
    numberOrNull(original.paymentTermsDays),
  );
  return body;
}

/** The project's budget lines, loaded once per open form. */
function useBudgetLines(projectId: string, enabled: boolean) {
  const [data, setData] = useState<BudgetLineOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setError(null);
    api
      .get<BudgetLineOptions>(`/api/v1/projects/${projectId}/bidding/budget-lines`)
      .then((res) => {
        if (live) setData(res);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "Budget lines could not be read.");
      });
    return () => {
      live = false;
    };
  }, [projectId, enabled]);
  return { data, error };
}

function PackageFormFields({
  form,
  set,
  projectId,
  open,
  /** true once bidders can see the package: the evaluation basis is frozen */
  basisFrozen,
  /** true once any bid exists: the estimate and the currency are frozen too */
  pricedFrozen,
  currentBidDueAt,
}: {
  form: PackageForm;
  set: (patch: Partial<PackageForm>) => void;
  projectId: string;
  open: boolean;
  basisFrozen: boolean;
  pricedFrozen: boolean;
  currentBidDueAt?: string | null;
}) {
  const budget = useBudgetLines(projectId, open);
  const budgetOptions = useMemo(
    () =>
      (budget.data?.items ?? []).map((line) => ({
        value: line.id,
        label: line.label,
        description: `${line.budgetName}${line.isActiveBudget ? " (active budget)" : ""} · ${line.currency}`,
        meta: money(line.revisedBudget, line.currency),
      })),
    [budget.data],
  );

  return (
    <div className="space-y-4">
      <Field label="Title" required>
        <Input
          value={form.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="Structural steelwork — frame and metal deck"
        />
      </Field>
      <Field label="Scope" hint="What the bidders are pricing.">
        <Textarea
          rows={3}
          value={form.scopeDescription}
          onChange={(e) => set({ scopeDescription: e.target.value })}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind">
          <Select value={form.packageKind} onChange={(e) => set({ packageKind: e.target.value })}>
            {PACKAGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {titleCase(k)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Procurement route">
          <Select
            value={form.procurementRoute}
            onChange={(e) => set({ procurementRoute: e.target.value })}
          >
            {PROCUREMENT_ROUTES.map((r) => (
              <option key={r} value={r}>
                {titleCase(r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Trade code"
          hint="Coverage by trade, cover-bidding and winner-rotation detection all key on this. Without it they have nothing to group by."
          optional
        >
          <Input
            value={form.tradeCode}
            onChange={(e) => set({ tradeCode: e.target.value })}
            placeholder="STEEL"
            maxLength={60}
          />
        </Field>
        <Field label="CSI division / work section" optional>
          <Input
            value={form.csiDivision}
            onChange={(e) => set({ csiDivision: e.target.value })}
            maxLength={60}
          />
        </Field>
        <Field
          label="Currency"
          hint={
            pricedFrozen
              ? "Frozen: bids have been recorded in this currency."
              : "Every figure on this package is in this currency."
          }
        >
          <Input
            value={form.currency}
            onChange={(e) => set({ currency: e.target.value })}
            maxLength={8}
            className="w-32"
            disabled={pricedFrozen}
          />
        </Field>
        <Field
          label="Pre-tender estimate"
          hint={
            pricedFrozen
              ? "Frozen: on a field of fewer than three bids this is what the abnormally-low control is measured against, so it cannot move after the prices are in the room."
              : "What makes 'everyone is 30% over' visible. Leave blank rather than guess."
          }
          optional
        >
          <Input
            type="number"
            inputMode="decimal"
            value={form.engineersEstimate}
            onChange={(e) => set({ engineersEstimate: e.target.value })}
            disabled={pricedFrozen}
          />
        </Field>
      </div>

      {/* ---------------- the timetable ---------------- */}
      <div className="rounded-lg border border-border bg-surface-sunken p-3">
        <p className="text-meta font-semibold">The timetable</p>
        <p className="mt-0.5 text-2xs leading-snug text-content-subtle">
          The award date and the validity period are the two halves of the bid-validity control:
          with both recorded the platform can say, before the deadline, which bidders will no
          longer be bound by their price on the day we mean to award.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Questions due" optional>
            <Input
              type="datetime-local"
              value={form.questionsDueAt}
              onChange={(e) => set({ questionsDueAt: e.target.value })}
            />
          </Field>
          <Field
            label="Bids due"
            hint={
              currentBidDueAt
                ? "May be extended, never shortened — bidders have planned around the current date."
                : "The instant that decides which bids are late. Required before the package can be issued."
            }
          >
            <Input
              type="datetime-local"
              value={form.bidDueAt}
              onChange={(e) => set({ bidDueAt: e.target.value })}
            />
          </Field>
          <Field
            label="Bid validity (days)"
            hint="How long a bidder is bound by their price after the deadline."
            optional
          >
            <Input
              type="number"
              inputMode="numeric"
              value={form.bidValidityDays}
              onChange={(e) => set({ bidValidityDays: e.target.value })}
              placeholder="90"
            />
          </Field>
          <Field label="Site visit" optional>
            <Input
              type="datetime-local"
              value={form.siteVisitAt}
              onChange={(e) => set({ siteVisitAt: e.target.value })}
            />
          </Field>
          <Field
            label="Anticipated award date"
            hint="What bid validity is measured against. Without it the clock is measured against today and nothing can be warned about."
            optional
          >
            <Input
              type="date"
              value={form.anticipatedAwardDate}
              onChange={(e) => set({ anticipatedAwardDate: e.target.value })}
            />
          </Field>
          <Field label="Anticipated start" optional>
            <Input
              type="date"
              value={form.anticipatedStartDate}
              onChange={(e) => set({ anticipatedStartDate: e.target.value })}
            />
          </Field>
          <Field label="Anticipated completion" optional>
            <Input
              type="date"
              value={form.anticipatedCompletionDate}
              onChange={(e) => set({ anticipatedCompletionDate: e.target.value })}
            />
          </Field>
        </div>
      </div>

      {/* ---------------- where the money lands ---------------- */}
      <div className="rounded-lg border border-border bg-surface-sunken p-3">
        <p className="text-meta font-semibold">Where the committed cost lands</p>
        <p className="mt-0.5 text-2xs leading-snug text-content-subtle">
          An approved award creates a commitment charged to the FIRST budget line named here. With
          none named the commitment is still created, but the project budget never sees the
          committed value.
        </p>
        {budget.error ? (
          <Alert tone="warning" className="mt-2">
            The project's budget lines could not be read ({budget.error}), so this cannot be set
            here. The award can still name a line at approval.
          </Alert>
        ) : budgetOptions.length === 0 ? (
          <p className="mt-2 text-2xs italic text-content-subtle">
            {budget.data
              ? budget.data.note
              : "Reading the project's budget lines…"}
          </p>
        ) : (
          <div className="mt-2">
            <MultiSelect
              value={form.budgetLineItemIds}
              onChange={(next) => set({ budgetLineItemIds: [...next] })}
              options={budgetOptions}
              placeholder="Choose the budget line(s) this package charges to"
              aria-label="Budget lines"
              maxVisible={2}
            />
          </div>
        )}
      </div>

      {/* ---------------- the evaluation basis ---------------- */}
      <div className="rounded-lg border border-border bg-surface-sunken p-3">
        <p className="text-meta font-semibold">
          The basis on which the winner will be chosen
        </p>
        <p className="mt-0.5 text-2xs leading-snug text-content-subtle">
          {basisFrozen
            ? "Frozen. The method, the criteria, the weights and the seal cannot change once the package has been issued or any bid has been recorded — that is the classic procurement-integrity failure, and it is refused rather than discouraged."
            : "Declared before bids open, never after. Once the package is issued none of this can move."}
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Evaluation method">
            <Select
              value={form.evaluationMethod}
              onChange={(e) => set({ evaluationMethod: e.target.value })}
              disabled={basisFrozen}
            >
              {EVALUATION_METHODS.map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Price weight %"
            hint="Both or neither: half a declared basis cannot produce a defensible total."
            optional
          >
            <Input
              type="number"
              inputMode="decimal"
              value={form.priceWeight}
              onChange={(e) => set({ priceWeight: e.target.value })}
              disabled={basisFrozen}
            />
          </Field>
          <Field label="Quality weight %" optional>
            <Input
              type="number"
              inputMode="decimal"
              value={form.qualityWeight}
              onChange={(e) => set({ qualityWeight: e.target.value })}
              disabled={basisFrozen}
            />
          </Field>
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between">
            <p className="text-label uppercase text-content-subtle">Scored criteria</p>
            <Button
              size="xs"
              variant="secondary"
              disabled={basisFrozen}
              onClick={() =>
                set({
                  criteria: [
                    ...form.criteria,
                    { key: "", label: "", weight: "", kind: "quality" },
                  ],
                })
              }
            >
              Add a criterion
            </Button>
          </div>
          {form.criteria.length === 0 ? (
            <p className="mt-1 text-2xs italic text-content-subtle">
              None declared — the award will rest on price and the levelled comparison alone.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {form.criteria.map((c, i) => (
                <li key={i} className="grid gap-2 sm:grid-cols-[7rem,1fr,6rem,7rem,auto]">
                  <Input
                    aria-label="Key"
                    placeholder="key"
                    value={c.key}
                    disabled={basisFrozen}
                    onChange={(e) =>
                      set({
                        criteria: form.criteria.map((row, j) =>
                          j === i ? { ...row, key: e.target.value } : row,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label="Label"
                    placeholder="What is being scored"
                    value={c.label}
                    disabled={basisFrozen}
                    onChange={(e) =>
                      set({
                        criteria: form.criteria.map((row, j) =>
                          j === i ? { ...row, label: e.target.value } : row,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label="Weight"
                    type="number"
                    placeholder="weight"
                    value={c.weight}
                    disabled={basisFrozen}
                    onChange={(e) =>
                      set({
                        criteria: form.criteria.map((row, j) =>
                          j === i ? { ...row, weight: e.target.value } : row,
                        ),
                      })
                    }
                  />
                  <Select
                    aria-label="Kind"
                    value={c.kind}
                    disabled={basisFrozen}
                    onChange={(e) =>
                      set({
                        criteria: form.criteria.map((row, j) =>
                          j === i
                            ? { ...row, kind: e.target.value === "price" ? "price" : "quality" }
                            : row,
                        ),
                      })
                    }
                  >
                    <option value="quality">Quality</option>
                    <option value="price">Price</option>
                  </Select>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={basisFrozen}
                    onClick={() =>
                      set({ criteria: form.criteria.filter((_, j) => j !== i) })
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ---------------- the seal ---------------- */}
      <div className="rounded-lg border border-border bg-surface-sunken p-3">
        <p className="flex items-center gap-2 text-meta font-semibold">
          <IconLock className="h-4 w-4" aria-hidden />
          The seal
        </p>
        <label className="mt-2 flex items-start gap-2 text-meta">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.isSealed}
            disabled={basisFrozen}
            onChange={(e) => set({ isSealed: e.target.checked })}
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
            checked={form.requiresOpeningWitness}
            disabled={!form.isSealed || basisFrozen}
            onChange={(e) => set({ requiresOpeningWitness: e.target.checked })}
          />
          <span>
            Require a witness at the opening, who may not be the opener. Waiving this is a
            recorded decision — a sealed bid opened by one person alone has no witness to the fact
            that the prices were not altered between the deadline and the record.
          </span>
        </label>
      </div>

      {/* ---------------- standing and terms ---------------- */}
      <div className="rounded-lg border border-border bg-surface-sunken p-3">
        <label className="flex items-start gap-2 text-meta">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.prequalificationRequired}
            onChange={(e) => set({ prequalificationRequired: e.target.checked })}
          />
          <span>Bidders must be prequalified.</span>
        </label>
        {form.prequalificationRequired ? (
          <Field
            className="mt-2"
            label="At award, a lapsed prequalification should"
            hint="Either way the lapse is named on the record."
          >
            <Select
              value={form.prequalificationStrictness}
              onChange={(e) =>
                set({
                  prequalificationStrictness: e.target.value === "warn" ? "warn" : "refuse",
                })
              }
              className="max-w-xs"
            >
              <option value="refuse">Refuse the award</option>
              <option value="warn">Warn, and record who accepted the risk</option>
            </Select>
          </Field>
        ) : null}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Retention %" optional>
            <Input
              type="number"
              inputMode="decimal"
              value={form.retentionPercent}
              onChange={(e) => set({ retentionPercent: e.target.value })}
            />
          </Field>
          <Field label="Payment terms (days)" optional>
            <Input
              type="number"
              inputMode="numeric"
              value={form.paymentTermsDays}
              onChange={(e) => set({ paymentTermsDays: e.target.value })}
            />
          </Field>
        </div>
      </div>
    </div>
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
  const [form, setForm] = useState<PackageForm>(EMPTY_FORM);
  const set = (patch: Partial<PackageForm>) => setForm((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    if (open) setForm(EMPTY_FORM);
  }, [open]);

  async function submit() {
    const created = await action.run("create", () =>
      api.post<{ id: string }>(`/api/v1/projects/${projectId}/bid-packages`, createBody(form)),
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
            disabled={form.title.trim().length === 0}
          >
            Create package
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        <PackageFormFields
          form={form}
          set={set}
          projectId={projectId}
          open={open}
          basisFrozen={false}
          pricedFrozen={false}
        />
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Edit                                                                */
/* ================================================================== */

function EditPackageModal({
  open,
  projectId,
  pkg,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  pkg: PackageDetail | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useAction();
  const original = useMemo(() => (pkg ? formFromPackage(pkg) : EMPTY_FORM), [pkg]);
  const [form, setForm] = useState<PackageForm>(original);
  const set = (patch: Partial<PackageForm>) => setForm((prev) => ({ ...prev, ...patch }));

  /*
   * Reset when the drawer OPENS or the underlying record changes — not on
   * every render of `original` (a fresh object each fetch), which would wipe
   * a half-typed edit the moment anything else reloaded the package.
   */
  const identity = `${pkg?.id ?? ""}:${pkg?.updatedAt ?? ""}`;
  useEffect(() => {
    if (open) setForm(original);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, identity]);

  const bidsRecorded = pkg?.counts.submissions ?? 0;
  const basisFrozen = Boolean(pkg?.issuedAt) || bidsRecorded > 0;
  const body = useMemo(() => patchBody(form, original), [form, original]);
  const changed = Object.keys(body).length;

  async function submit() {
    if (!pkg || changed === 0) return;
    const done = await action.run("save", () =>
      api.patch(`/api/v1/projects/${projectId}/bid-packages/${pkg.id}`, body),
    );
    if (done) onSaved();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={pkg ? `Edit ${pkg.reference}` : "Edit bid package"}
      size="lg"
      description="Everything the package carries into the award: the trade it is grouped under, the budget line it charges, the timetable the validity clock runs on, and — until it is issued — the evaluation basis."
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs text-content-subtle">
            {changed === 0
              ? "Nothing has changed yet."
              : `${changed} field${changed === 1 ? "" : "s"} will be sent.`}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              loading={action.busy === "save"}
              disabled={changed === 0 || form.title.trim().length === 0}
            >
              Save changes
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        {basisFrozen ? (
          <Alert tone="info" title="The evaluation basis is frozen">
            {pkg?.issuedAt
              ? "This package has been issued to bidders"
              : `${bidsRecorded} bid(s) have been recorded`}
            , so the method, the criteria, the weights and the seal can no longer move. The scope
            narrative, the timetable (forwards only), the budget lines and the commercial terms
            still can.
          </Alert>
        ) : null}
        {pkg ? (
          <PackageFormFields
            form={form}
            set={set}
            projectId={projectId}
            open={open}
            basisFrozen={basisFrozen}
            pricedFrozen={bidsRecorded > 0}
            currentBidDueAt={pkg.bidDueAt}
          />
        ) : null}
      </div>
    </Modal>
  );
}
