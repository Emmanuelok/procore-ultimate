/**
 * BIDS — and the seal, rendered as the control it is.
 *
 * The one thing this screen must never do is let "withheld" look like "zero".
 * While the package is sealed the API returns every amount as `null` WITH THE
 * KEY RETAINED, so the client can tell a withheld price from a nil one; here
 * that becomes the word `sealed` in the warning tone, never a blank cell and
 * never a dash.
 *
 * The opening is presented as what it is: three conditions, all of which must
 * hold before the seal lifts.
 *
 *   1. THE TIME HAS PASSED — sealedUntil, or the bid deadline. Opening early is
 *      refused, because a price read before the deadline can be passed to a
 *      competitor who has not yet bid.
 *   2. AN OPENER IS NAMED — you, and you are named in the ledger entry.
 *   3. A WITNESS IS NAMED, AND IS NOT THE OPENER. Waivable per package as a
 *      recorded decision; the default is that a witness is required, because a
 *      witness who is the opener witnesses nothing.
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
import { IconClock, IconLock, IconPlus, IconUsers, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  AmountCell,
  CapacityNote,
  LoadError,
  LoadingBlock,
  MoneyStat,
  PREQUAL_LABEL,
  PREQUAL_TONE,
  RefusalPanel,
  ReasonList,
  SealBanner,
  Sealed,
  complianceTone,
  dateTime,
  money,
  num,
  submissionTone,
  titleCase,
  useAction,
  useCompanyUsers,
  useResource,
  useVendors,
} from "./biddingShared";
import type { PackageDetail, SubmissionDetail, Tabulation, TabulationRow } from "./types";

const COMPLIANCE_STATUSES = [
  "pending_review",
  "compliant",
  "qualified",
  "conditional",
  "non_compliant",
] as const;

export default function SubmissionsTab({
  projectId,
  packageId,
  pkg,
  loading,
  onMutated,
}: {
  projectId: string;
  packageId: string;
  pkg: PackageDetail | null;
  loading: boolean;
  onMutated: () => void;
}) {
  const [version, setVersion] = useState(0);
  const tab = useResource<Tabulation>(
    packageId
      ? `/api/v1/projects/${projectId}/bid-packages/${packageId}/tabulation?_v=${version}`
      : null,
  );
  const action = useAction();
  const [openingOpen, setOpeningOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  function refresh() {
    setVersion((n) => n + 1);
    onMutated();
  }

  const seal = tab.data?.seal ?? pkg?.seal ?? null;
  const withheld = seal?.amountsWithheld ?? false;
  const rows = tab.data?.rows ?? [];
  const currency = tab.data?.package.currency ?? pkg?.currency ?? "USD";

  const columns: DataColumns<TabulationRow> = useMemo(
    () => [
      {
        id: "reference",
        header: "Bid",
        accessor: "reference",
        type: "code",
        width: 120,
        sticky: "start",
      },
      {
        id: "vendor",
        header: "Bidder",
        accessor: (row) => row.vendorName ?? row.vendorId,
        type: "text",
        width: 200,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 140,
        cell: ({ row }) => (
          <Badge tone={submissionTone(row.status)} size="xs" dot variant="subtle">
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "total",
        header: "Total as bid",
        accessor: "totalAmount",
        type: "currency",
        width: 160,
        align: "right",
        cell: ({ row }) => (
          <AmountCell value={row.totalAmount} currency={row.currency} sealed={row.sealed} />
        ),
      },
      {
        id: "levelled",
        header: "Levelled (comparable)",
        accessor: "normalisedAmount",
        type: "currency",
        width: 190,
        align: "right",
        cell: ({ row }) =>
          row.sealed ? (
            <Sealed compact />
          ) : row.normalisedAmount === null ? (
            <span
              className="text-2xs italic text-content-subtle"
              title="Levelling has not been completed for this bid, so there is no like-for-like figure to compare."
            >
              not levelled
            </span>
          ) : (
            <span className="tabular-nums font-medium">
              {money(row.normalisedAmount, row.currency)}
            </span>
          ),
      },
      {
        id: "late",
        header: "Lateness",
        accessor: (row) => (row.isLate === 1 ? (row.lateAcceptedBy ? 1 : 2) : 0),
        width: 220,
        cell: ({ row }) =>
          row.isLate !== 1 ? (
            <span className="text-2xs text-content-subtle">on time</span>
          ) : row.lateAcceptedBy ? (
            <div className="min-w-0">
              <Badge tone="warning" size="xs" variant="subtle">
                accepted late
              </Badge>
              <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-muted">
                {row.lateAcceptanceReason}
              </p>
            </div>
          ) : (
            <div className="min-w-0">
              <Badge tone="danger" size="xs" variant="subtle" dot>
                {row.lateByMinutes ?? "?"} min late — not accepted
              </Badge>
              <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-muted">
                Cannot be levelled, scored or awarded until somebody accepts it with a stated
                reason.
              </p>
            </div>
          ),
      },
      {
        id: "compliance",
        header: "Compliance",
        accessor: "complianceStatus",
        type: "status",
        width: 150,
        cell: ({ row }) => (
          <Badge tone={complianceTone(row.complianceStatus)} size="xs" variant="subtle" dot>
            {titleCase(row.complianceStatus)}
          </Badge>
        ),
      },
      {
        id: "prequal",
        header: "Prequalification",
        accessor: (row) => row.prequalification.state,
        type: "text",
        width: 240,
        cell: ({ row }) => (
          <div className="min-w-0 py-0.5">
            <Badge tone={PREQUAL_TONE[row.prequalification.state]} size="xs" dot variant="subtle">
              {PREQUAL_LABEL[row.prequalification.state]}
            </Badge>
            <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-muted">
              {row.prequalification.note}
            </p>
          </div>
        ),
      },
      {
        id: "capacity",
        header: "Against approved capacity",
        accessor: (row) => row.capacity?.severity ?? "unknown",
        width: 250,
        cell: ({ row }) => <CapacityNote check={row.capacity} compact />,
      },
      {
        id: "envelope",
        header: "Envelope hash",
        accessor: "sealedSha256",
        width: 160,
        cell: ({ row }) =>
          row.sealedSha256 ? (
            <code
              className="font-mono text-2xs"
              title={`sha256 ${row.sealedSha256} — recorded at receipt and carried into the opening ledger entry.`}
            >
              {row.sealedSha256.slice(0, 12)}…
            </code>
          ) : (
            <span className="text-2xs text-content-subtle">none recorded</span>
          ),
      },
    ],
    [],
  );

  if (loading && !pkg) return <LoadingBlock rows={5} />;
  if (tab.loading && !tab.data) return <LoadingBlock rows={5} />;
  if (tab.error) return <LoadError message={tab.error} onRetry={tab.reload} />;

  const market = tab.data?.market;

  return (
    <div className="space-y-4">
      <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

      {seal ? <SealBanner seal={seal} onOpen={() => setOpeningOpen(true)} /> : null}

      {seal?.isSealed && !seal.isOpened ? <OpeningRequirements seal={seal} /> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardBody>
            <MoneyStat
              label="Pre-tender estimate"
              value={tab.data?.package.engineersEstimate ?? null}
              currency={currency}
              hint={
                (tab.data?.package.engineersEstimate ?? null) === null
                  ? "None recorded — nothing to measure the market against."
                  : undefined
              }
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">Lowest bid</div>
            <div className="mt-0.5 text-base font-semibold tabular-nums">
              {withheld ? (
                <Sealed />
              ) : market && market.lowest.value !== null ? (
                money(market.lowest.value, currency)
              ) : (
                <span className="text-sm font-normal italic text-content-subtle">
                  not available
                </span>
              )}
            </div>
            {!withheld && market && market.lowest.value === null ? (
              <p className="mt-1 text-2xs leading-snug text-content-subtle">
                {market.lowest.reasons.join(" ")}
              </p>
            ) : null}
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">Against the estimate</div>
            <div className="mt-0.5 text-base font-semibold tabular-nums">
              {withheld ? (
                <Sealed />
              ) : market && market.againstEstimatePercent.value !== null ? (
                `${num(market.againstEstimatePercent.value, 1)}%`
              ) : (
                <span className="text-sm font-normal italic text-content-subtle">
                  not available
                </span>
              )}
            </div>
            {!withheld && market && market.againstEstimatePercent.value === null ? (
              <p className="mt-1 text-2xs leading-snug text-content-subtle">
                {market.againstEstimatePercent.reasons.join(" ")}
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-meta leading-relaxed text-content-muted">
          The bid tabulation, as of {tab.data?.asOf ?? "—"}. Bids are compared on their levelled
          amounts, not their as-bid totals — the cheapest as-bid number frequently belongs to
          whoever read the scope least carefully.
        </p>
        <Button icon={IconPlus} onClick={() => setRecordOpen(true)}>
          Record a bid
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={IconUsers}
          title="No bids have been received"
          hint={
            seal?.isSealed
              ? "Nothing has arrived against this package yet. When bids do arrive their amounts stay withheld until the seal lawfully lifts — an unopened bid is an unread bid."
              : "Nothing has arrived against this package yet. Record a bid as it is received; the receipt time, not 'now', is what decides whether it was late."
          }
          action={
            <Button icon={IconPlus} onClick={() => setRecordOpen(true)}>
              Record a bid
            </Button>
          }
        />
      ) : (
        <DataTable<TabulationRow>
          tableId="bidding.tabulation"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={520}
          rowHeight={64}
          stickyHeader
          filterRow
          searchPlaceholder="Search bids…"
          exportFileName="bid-tabulation"
          onRowClick={({ row }) => setOpenId(row.id)}
          rowTone={(row) =>
            row.isLate === 1 && !row.lateAcceptedBy
              ? "danger"
              : row.complianceStatus === "non_compliant"
                ? "warning"
                : undefined
          }
          empty={{
            title: "No bids match",
            description: "Every bid on this package is filtered out by the current filters.",
          }}
        />
      )}

      <SubmissionDrawer
        submissionId={openId}
        onClose={() => setOpenId(null)}
        onMutated={refresh}
      />

      <OpeningModal
        open={openingOpen}
        projectId={projectId}
        packageId={packageId}
        seal={seal}
        bidsInTheRoom={rows.length}
        onClose={() => setOpeningOpen(false)}
        onOpened={() => {
          setOpeningOpen(false);
          refresh();
        }}
      />

      <RecordBidModal
        open={recordOpen}
        projectId={projectId}
        packageId={packageId}
        currency={currency}
        sealed={pkg?.isSealed === 1}
        onClose={() => setRecordOpen(false)}
        onCreated={refresh}
        onDone={() => {
          setRecordOpen(false);
          refresh();
        }}
      />
    </div>
  );
}

/* ================================================================== */
/* The opening requirements, spelled out                               */
/* ================================================================== */

function OpeningRequirements({ seal }: { seal: NonNullable<PackageDetail["seal"]> }) {
  const conditions = [
    {
      label: "The time has passed",
      met: seal.mayOpenNow,
      detail: seal.opensAt
        ? seal.mayOpenNow
          ? `The seal was due to lift at ${dateTime(seal.opensAt)}.`
          : `The seal does not lift until ${dateTime(seal.opensAt)}. Opening a sealed package early is the procurement failure the seal exists to prevent.`
        : "This package carries neither a bid due date nor a sealed-until time, so there is no moment at which the seal may lift. It cannot be opened at all until the timetable is set.",
    },
    {
      label: "An opener is named",
      met: true,
      detail:
        "You. Your name, the time, the envelope hashes and the number of bids in the room all go into the ledger entry.",
    },
    {
      label: "A witness is named, and is not the opener",
      met: !seal.requiresWitness,
      detail: seal.requiresWitness
        ? "This package requires a witness. A sealed bid opened by one person alone has no witness to the fact that the prices were not altered between the deadline and the record."
        : "A witness has been waived on this package — a recorded decision, taken before bids were invited.",
    },
  ];
  return (
    <Card>
      <CardBody>
        <p className="flex items-center gap-2 text-sm font-semibold">
          <IconLock className="h-4 w-4" aria-hidden />
          What the opening requires
        </p>
        <ul className="mt-2 space-y-2">
          {conditions.map((c) => (
            <li key={c.label} className="flex items-start gap-2">
              <Badge tone={c.met ? "success" : "warning"} size="xs" variant="subtle">
                {c.met ? "satisfied" : "outstanding"}
              </Badge>
              <div className="min-w-0">
                <p className="text-meta font-medium">{c.label}</p>
                <p className="text-2xs leading-snug text-content-muted">{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* The opening                                                         */
/* ================================================================== */

function OpeningModal({
  open,
  projectId,
  packageId,
  seal,
  bidsInTheRoom,
  onClose,
  onOpened,
}: {
  open: boolean;
  projectId: string;
  packageId: string;
  seal: PackageDetail["seal"] | null;
  bidsInTheRoom: number;
  onClose: () => void;
  onOpened: () => void;
}) {
  const users = useCompanyUsers();
  const { user } = useAuth();
  const action = useAction();
  const [witnessUserId, setWitnessUserId] = useState("");
  const [witnessName, setWitnessName] = useState("");
  const [note, setNote] = useState("");

  const needsWitness = seal?.requiresWitness ?? true;
  const blocked = !seal?.mayOpenNow || (needsWitness && !witnessUserId);

  async function submit() {
    const body: Record<string, unknown> = {};
    if (witnessUserId) body["witnessUserId"] = witnessUserId;
    if (witnessName.trim()) body["witnessName"] = witnessName.trim();
    if (note.trim()) body["note"] = note.trim();
    const done = await action.run("open", () =>
      api.post(`/api/v1/projects/${projectId}/bid-packages/${packageId}/open`, body),
    );
    if (done) onOpened();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Break the seal"
      size="lg"
      tone="warning"
      icon={IconLock}
      description={`${bidsInTheRoom} bid(s) are in the room.`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={action.busy === "open"} disabled={blocked}>
            Record the opening
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        <Alert tone="warning" title="A seal is broken once">
          There is no second opening: a second one would overwrite the record of the first. This
          call is ledgered with you, the witness, the time the seal was due to lift, the number of
          bids in the room and the sha256 of every envelope.
        </Alert>

        {!seal?.mayOpenNow ? (
          <Alert tone="danger" title="Not yet" icon={IconClock}>
            {seal?.note ??
              "The seal has not reached the moment at which it may lift, so an opening cannot be recorded."}
          </Alert>
        ) : null}

        <Field
          label="Witness"
          required={needsWitness}
          hint={
            needsWitness
              ? "Must be somebody other than you. A witness who is the opener witnesses nothing, and the API refuses it."
              : "A witness has been waived on this package, but naming one is still better evidence."
          }
        >
          <Select
            value={witnessUserId}
            onChange={(e) => setWitnessUserId(e.target.value)}
            placeholder="Choose the witness"
          >
            {/* You are not in this list: a witness who is the opener witnesses nothing. */}
            {[...users.entries()]
              .filter(([id]) => id !== user?.id)
              .map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
          </Select>
        </Field>

        <Field
          label="Witness name for the record"
          optional
          hint="Where the witness is not a platform user — an auditor, a client representative."
        >
          <Input value={witnessName} onChange={(e) => setWitnessName(e.target.value)} />
        </Field>

        <Field label="Note" optional hint="Anything about the opening worth recording.">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* One bid                                                             */
/* ================================================================== */

function SubmissionDrawer({
  submissionId,
  onClose,
  onMutated,
}: {
  submissionId: string | null;
  onClose: () => void;
  onMutated: () => void;
}) {
  const detail = useResource<SubmissionDetail>(
    submissionId ? `/api/v1/bid-submissions/${submissionId}` : null,
  );
  const action = useAction();
  const [lateReason, setLateReason] = useState("");
  const [complianceStatus, setComplianceStatus] = useState("compliant");
  const [complianceNote, setComplianceNote] = useState("");
  const sub = detail.data;

  async function acceptLate() {
    if (!submissionId) return;
    const done = await action.run("late", () =>
      api.post(`/api/v1/bid-submissions/${submissionId}/accept-late`, {
        reason: lateReason.trim(),
      }),
    );
    if (done) {
      setLateReason("");
      detail.reload();
      onMutated();
    }
  }

  async function setCompliance() {
    if (!submissionId) return;
    const done = await action.run("compliance", () =>
      api.post(`/api/v1/bid-submissions/${submissionId}/compliance`, {
        complianceStatus,
        note: complianceNote.trim() || null,
      }),
    );
    if (done) {
      setComplianceNote("");
      detail.reload();
      onMutated();
    }
  }

  return (
    <Drawer
      open={submissionId !== null}
      onClose={onClose}
      size="lg"
      title={sub ? `${sub.reference} — ${sub.vendorName ?? sub.vendorId}` : "Bid"}
      description={sub ? `Against ${sub.packageReference}` : undefined}
    >
      {detail.loading && !sub ? (
        <LoadingBlock rows={3} />
      ) : detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : sub ? (
        <div className="space-y-4">
          <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

          {sub.sealed ? (
            <Alert tone="warning" title="Every figure on this bid is withheld" icon={IconLock}>
              <p>{sub.sealNote}</p>
              <p className="mt-1 text-meta">
                Withheld fields: {sub.withheldFields.join(", ")}. The keys are returned valued null
                so a client cannot mistake a withheld price for a zero — and this screen will not
                either.
              </p>
            </Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <MoneyStat
              label="Base bid"
              value={sub.baseBidAmount}
              currency={sub.currency}
              sealed={sub.sealed}
            />
            <MoneyStat
              label="Total as bid"
              value={sub.totalAmount}
              currency={sub.currency}
              sealed={sub.sealed}
            />
            <MoneyStat
              label="Provisional sums"
              value={sub.provisionalSumsTotal}
              currency={sub.currency}
              sealed={sub.sealed}
            />
            <MoneyStat
              label="Levelled (comparable)"
              value={sub.normalisedAmount}
              currency={sub.currency}
              sealed={sub.sealed}
              hint={
                !sub.sealed && sub.normalisedAmount === null
                  ? "Levelling has not been completed for this bid."
                  : "This figure, not the as-bid total, is what an award is measured against."
              }
            />
          </div>

          <section>
            <h3 className="text-label uppercase text-content-subtle">Lateness</h3>
            <Alert
              className="mt-2"
              tone={
                sub.lateness.isLate ? (sub.lateness.accepted ? "warning" : "danger") : "success"
              }
              variant="subtle"
              size="sm"
              icon={sub.lateness.isLate ? IconWarning : false}
            >
              {sub.lateness.note}
            </Alert>
            {sub.lateness.isLate && !sub.lateness.accepted ? (
              <div className="mt-2 space-y-2 rounded-lg border border-danger-border bg-danger-subtle p-3">
                <p className="text-meta text-danger-fg">
                  Letting a late bid into the comparison is a decision somebody takes in writing.
                  &ldquo;They are the incumbent&rdquo; and &ldquo;the courier was held at the gate
                  for eleven minutes&rdquo; are different decisions, and only one of them survives a
                  challenge.
                </p>
                <Field
                  label="Why this late bid is being accepted"
                  required
                  hint="At least 20 characters — this is the whole of the audit answer."
                >
                  <Textarea
                    rows={3}
                    value={lateReason}
                    onChange={(e) => setLateReason(e.target.value)}
                  />
                </Field>
                <div className="flex justify-end">
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={lateReason.trim().length < 20}
                    loading={action.busy === "late"}
                    onClick={() => void acceptLate()}
                  >
                    Accept it late
                  </Button>
                </div>
              </div>
            ) : null}
          </section>

          <section>
            <h3 className="text-label uppercase text-content-subtle">Standing and capacity</h3>
            <Alert
              className="mt-2"
              tone={PREQUAL_TONE[sub.prequalification.state]}
              variant="subtle"
              size="sm"
              title={PREQUAL_LABEL[sub.prequalification.state]}
            >
              {sub.prequalification.flag ?? sub.prequalification.note}
            </Alert>
            <div className="mt-2">
              <CapacityNote check={sub.capacity} />
            </div>
          </section>

          <section>
            <h3 className="text-label uppercase text-content-subtle">Compliance</h3>
            <Alert
              className="mt-2"
              tone={complianceTone(sub.complianceStatus)}
              variant="subtle"
              size="sm"
              title={titleCase(sub.complianceStatus)}
            >
              {sub.nonComplianceNote ??
                (sub.complianceStatus === "pending_review"
                  ? "Nobody has yet said whether this bid answers the question that was asked."
                  : "No note was recorded against this finding.")}
            </Alert>
            <div className="mt-2 grid gap-2 sm:grid-cols-[12rem_1fr]">
              <Field label="Set the finding">
                <Select
                  value={complianceStatus}
                  onChange={(e) => setComplianceStatus(e.target.value)}
                >
                  {COMPLIANCE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {titleCase(s)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Note"
                hint="Required for anything other than compliant — a status with no explanation cannot be put to the bidder or defended."
              >
                <Input
                  value={complianceNote}
                  onChange={(e) => setComplianceNote(e.target.value)}
                  placeholder="What is wrong with the bid"
                />
              </Field>
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                loading={action.busy === "compliance"}
                onClick={() => void setCompliance()}
              >
                Record the finding
              </Button>
            </div>
          </section>

          {sub.exclusions || sub.qualifications ? (
            <section>
              <h3 className="text-label uppercase text-content-subtle">
                What the bidder said they are NOT pricing
              </h3>
              <DescriptionList
                className="mt-2"
                columns={1}
                size="sm"
                items={[
                  ...(sub.exclusions
                    ? [{ label: "Exclusions", value: sub.exclusions as string }]
                    : []),
                  ...(sub.qualifications
                    ? [{ label: "Qualifications", value: sub.qualifications as string }]
                    : []),
                ]}
              />
              <p className="mt-1 text-2xs text-content-subtle">
                Every one of these belongs on a levelling row with a priced adjustment, or the
                comparison treats the missing scope as free.
              </p>
            </section>
          ) : null}

          <section>
            <h3 className="text-label uppercase text-content-subtle">Receipt record</h3>
            <DescriptionList
              className="mt-2"
              columns={2}
              size="sm"
              items={[
                { label: "Received", value: dateTime(sub.receivedAt) },
                { label: "Submitted", value: dateTime(sub.submittedAt) },
                { label: "Revision", value: String(sub.revision) },
                { label: "Priced lines", value: String(sub.lineCount) },
                {
                  label: "Envelope sha256",
                  value: sub.sealedSha256 ? (
                    <code className="break-all font-mono text-2xs">{sub.sealedSha256}</code>
                  ) : (
                    "none recorded"
                  ),
                  span: 2,
                },
                { label: "Opened at", value: dateTime(sub.openedAt), span: 2 },
              ]}
            />
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}

/* ================================================================== */
/* Record a bid                                                        */
/* ================================================================== */

function RecordBidModal({
  open,
  projectId,
  packageId,
  currency,
  sealed,
  onClose,
  onCreated,
  onDone,
}: {
  open: boolean;
  projectId: string;
  packageId: string;
  currency: string;
  sealed: boolean;
  onClose: () => void;
  /** Fired on every successful write, notes or no notes. */
  onCreated: () => void;
  onDone: () => void;
}) {
  const vendors = useVendors();
  const action = useAction();
  const [vendorId, setVendorId] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [base, setBase] = useState("");
  const [provisional, setProvisional] = useState("");
  const [allowances, setAllowances] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [sha, setSha] = useState("");
  const [notes, setNotes] = useState<string[]>([]);

  async function submit() {
    const body: Record<string, unknown> = { vendorId, currency };
    if (receivedAt) body["receivedAt"] = new Date(receivedAt).toISOString();
    if (base.trim()) body["baseBidAmount"] = Number(base);
    if (provisional.trim()) body["provisionalSumsTotal"] = Number(provisional);
    if (allowances.trim()) body["allowancesTotal"] = Number(allowances);
    if (exclusions.trim()) body["exclusions"] = exclusions.trim();
    if (sha.trim()) body["sealedSha256"] = sha.trim().toLowerCase();
    const res = await action.run("record", () =>
      api.post<{ totalsNotes?: string[]; latenessNote?: string | null }>(
        `/api/v1/projects/${projectId}/bid-packages/${packageId}/submissions`,
        body,
      ),
    );
    if (res) {
      /*
       * The bid IS recorded by this point. Showing the notes without
       * refreshing the register left the buyer looking at a list that did not
       * contain the bid they had just entered — and provisional sums alone are
       * enough to produce a note, so it happened routinely.
       */
      const collected = [...(res.totalsNotes ?? []), ...(res.latenessNote ? [res.latenessNote] : [])];
      onCreated();
      if (collected.length > 0) setNotes(collected);
      else onDone();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a bid"
      size="lg"
      description="The receipt time, not 'now', is what decides whether this bid was late."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => void submit()}
            loading={action.busy === "record"}
            disabled={!vendorId}
          >
            Record the bid
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        {notes.length > 0 ? (
          <Alert
            tone="info"
            title="Recorded — with these notes"
            actions={
              <Button size="sm" variant="secondary" onClick={onDone}>
                Done
              </Button>
            }
          >
            <ReasonList reasons={notes} tone="info" />
          </Alert>
        ) : null}
        {sealed ? (
          <Alert tone="warning" variant="subtle" size="sm" icon={IconLock}>
            This package is sealed. The amounts entered here are stored, but no read path on the
            platform will return them — not even to you — until the seal lawfully lifts.
          </Alert>
        ) : null}
        <Field label="Bidder" required>
          <Select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            placeholder="Choose the vendor"
          >
            {(vendors.data?.items ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Received at"
          hint="When the bid actually arrived. Leave blank to use now."
          optional
        >
          <Input
            type="datetime-local"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={`Base bid (${currency})`}>
            <Input
              type="number"
              inputMode="decimal"
              value={base}
              onChange={(e) => setBase(e.target.value)}
            />
          </Field>
          <Field label="Provisional sums" optional>
            <Input
              type="number"
              inputMode="decimal"
              value={provisional}
              onChange={(e) => setProvisional(e.target.value)}
            />
          </Field>
          <Field label="Allowances" optional>
            <Input
              type="number"
              inputMode="decimal"
              value={allowances}
              onChange={(e) => setAllowances(e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Exclusions, verbatim"
          optional
          hint="Whatever the bidder said they are not pricing. Each one needs a levelling row with a priced adjustment, or the comparison treats the missing scope as free."
        >
          <Textarea rows={3} value={exclusions} onChange={(e) => setExclusions(e.target.value)} />
        </Field>
        <Field
          label="Sealed envelope sha256"
          optional
          hint="Content-addressed at the moment of receipt, and carried into the opening ledger entry."
        >
          <Input
            value={sha}
            onChange={(e) => setSha(e.target.value)}
            placeholder="64 lowercase hex characters"
            className="font-mono"
          />
        </Field>
      </div>
    </Modal>
  );
}
