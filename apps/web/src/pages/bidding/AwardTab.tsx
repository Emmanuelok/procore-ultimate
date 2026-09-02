/**
 * AWARD — and the two columns every procurement audit asks for.
 *
 *   isLowestBid              was this the lowest comparable bid?
 *   notLowestJustification   and if not, WHY, in writing.
 *
 * The lowest bid amount is recorded and shown alongside whether or not it was
 * taken, because that is the auditor's anchor. A recommendation that is not the
 * lowest comparable bid is REFUSED without a written justification — this
 * screen shows the refusal in the API's own words rather than hiding the
 * control behind a disabled button.
 *
 * Approval is by somebody who is neither the author nor the recommender, and on
 * approval the award creates the COMMITMENT in the commitments module, with
 * `bid_awards.commitmentId` as the seam.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DescriptionList,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from "../../ui";
import { cx } from "../../ui/cx";
import { IconApproval, IconContract, IconLock, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  LoadError,
  LoadingBlock,
  ReasonList,
  RefusalPanel,
  awardTone,
  dateTime,
  distinctCurrencies,
  money,
  num,
  titleCase,
  useAction,
  useNames,
  useReason,
  useResource,
} from "./biddingShared";
import type { BidAward, ListResponse, PackageDetail, Tabulation, TabulationRow } from "./types";

interface Candidate {
  submissionId: string;
  reference: string;
  vendorName: string;
  comparableAmount: number | null;
  asBidAmount: number | null;
  currency: string;
  basis: "levelled" | "as_bid";
  inContention: boolean;
  blockedReason: string | null;
}

export default function AwardTab({
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
  const awards = useResource<ListResponse<BidAward>>(
    packageId
      ? `/api/v1/projects/${projectId}/bid-packages/${packageId}/awards?_v=${version}`
      : null,
  );
  const tabulation = useResource<Tabulation>(
    packageId
      ? `/api/v1/projects/${projectId}/bid-packages/${packageId}/tabulation?_v=${version}`
      : null,
  );
  const action = useAction();
  const { ask, dialog } = useReason();
  const nameOf = useNames();
  const [recommendOpen, setRecommendOpen] = useState(false);

  function refresh() {
    setVersion((n) => n + 1);
    onMutated();
  }

  const seal = tabulation.data?.seal ?? pkg?.seal ?? null;

  /**
   * The comparison the award will rest on, derived exactly as the API derives
   * it: the LEVELLED amount wherever the package has been levelled, the as-bid
   * total otherwise — stated either way, because "lowest bid" means something
   * different under each.
   */
  const comparison = useMemo(() => {
    const rows: TabulationRow[] = tabulation.data?.rows ?? [];
    const contenders = rows.filter(
      (r) =>
        !["draft", "unsuccessful", "withdrawn"].includes(r.status) &&
        !(r.isLate === 1 && !r.lateAcceptedBy),
    );
    const levelled = contenders.length > 0 && contenders.every((r) => r.normalisedAmount !== null);
    const candidates: Candidate[] = contenders.map((r) => ({
      submissionId: r.id,
      reference: r.reference,
      vendorName: r.vendorName ?? r.vendorId,
      comparableAmount: levelled ? r.normalisedAmount : r.totalAmount,
      asBidAmount: r.totalAmount,
      currency: r.currency,
      basis: levelled ? "levelled" : "as_bid",
      inContention: true,
      blockedReason:
        r.isLate === 1 && !r.lateAcceptedBy
          ? "arrived late and has not been accepted"
          : null,
    }));
    const priced = candidates.filter((c) => c.comparableAmount !== null);
    const currencies = distinctCurrencies(candidates.map((c) => c.currency));
    const lowest =
      currencies.length === 1 && priced.length > 0
        ? priced.reduce((min, c) =>
            (c.comparableAmount ?? Infinity) < (min.comparableAmount ?? Infinity) ? c : min,
          )
        : null;
    return {
      basis: levelled ? ("levelled" as const) : ("as_bid" as const),
      candidates,
      lowest,
      currencies,
      mixedCurrency: currencies.length > 1,
    };
  }, [tabulation.data]);

  if (awards.loading && !awards.data) return <LoadingBlock rows={4} />;
  if (awards.error) return <LoadError message={awards.error} onRetry={awards.reload} />;

  const items = awards.data?.items ?? [];
  const live = items.find(
    (a) => !["rejected", "withdrawn", "cancelled"].includes(a.status),
  );

  if (seal?.amountsWithheld) {
    return (
      <EmptyState
        icon={IconLock}
        tone="warning"
        title="Nothing can be awarded while the bids are sealed"
        hint={`Recommending an award requires reading submitted amounts. ${seal.note}`}
      />
    );
  }

  async function act(key: string, awardId: string, path: string, body?: unknown) {
    const done = await action.run(`${key}:${awardId}`, () =>
      api.post(`/api/v1/bid-awards/${awardId}/${path}`, body ?? {}),
    );
    if (done) refresh();
  }

  return (
    <div className="space-y-4">
      <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

      {/* ------------------------------------------------------------ */}
      {/* What "lowest" means on this package                           */}
      {/* ------------------------------------------------------------ */}
      <Alert
        tone={comparison.basis === "levelled" ? "success" : "warning"}
        title={
          comparison.basis === "levelled"
            ? "Bids are compared on their LEVELLED amounts"
            : "Bids are compared on their AS-BID totals — this package has not been levelled"
        }
        icon={comparison.basis === "levelled" ? undefined : IconWarning}
      >
        {comparison.basis === "levelled" ? (
          <p>
            The like-for-like figures produced by the levelling, not the numbers the bidders wrote.
          </p>
        ) : (
          <p>
            As-bid totals are not like-for-like: the cheapest as-bid number frequently belongs to
            whoever read the scope least carefully. Level the package before awarding on it.
          </p>
        )}
        {comparison.mixedCurrency ? (
          <p className="mt-1">
            Bids still in contention are priced in {comparison.currencies.join(", ")}. This platform
            never ranks figures in different currencies against each other, so there is no lowest
            bid to name and the API will refuse a recommendation until they are restated in one
            currency.
          </p>
        ) : null}
      </Alert>

      {/* ------------------------------------------------------------ */}
      {/* The lowest bid, named, whether or not it is taken             */}
      {/* ------------------------------------------------------------ */}
      {comparison.candidates.length > 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm font-semibold">The comparison an award would rest on</p>
            <ul className="mt-2 space-y-1.5">
              {[...comparison.candidates]
                .sort(
                  (a, b) =>
                    (a.comparableAmount ?? Infinity) - (b.comparableAmount ?? Infinity),
                )
                .map((c) => {
                  const isLowest = comparison.lowest?.submissionId === c.submissionId;
                  return (
                    <li
                      key={c.submissionId}
                      className={cx(
                        "flex flex-wrap items-baseline justify-between gap-2 rounded-md border p-2",
                        isLowest
                          ? "border-success-border bg-success-subtle"
                          : "border-border bg-surface-raised",
                      )}
                    >
                      <div className="min-w-0">
                        <span className="text-meta font-medium">{c.vendorName}</span>
                        <span className="ml-2 text-2xs text-content-subtle">{c.reference}</span>
                        {isLowest ? (
                          <Badge tone="success" size="xs" className="ml-2">
                            lowest comparable bid
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-right">
                        <div className="tabular-nums text-sm font-semibold">
                          {c.comparableAmount === null ? (
                            <span className="text-meta font-normal italic text-content-subtle">
                              no comparable amount
                            </span>
                          ) : (
                            money(c.comparableAmount, c.currency)
                          )}
                        </div>
                        {c.basis === "levelled" && c.asBidAmount !== null ? (
                          <div className="text-2xs tabular-nums text-content-subtle">
                            as bid {money(c.asBidAmount, c.currency)}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-meta leading-relaxed text-content-muted">
          A recommendation that is not the lowest comparable bid requires a written justification.
          That record, alongside the lowest bid amount, is precisely what an auditor asks for — and
          it cannot be written afterwards.
        </p>
        <Button
          onClick={() => setRecommendOpen(true)}
          disabled={Boolean(live) || comparison.candidates.length === 0}
        >
          Recommend an award
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={IconApproval}
          title="No award has been recommended on this package"
          hint="An award records who was chosen, on what comparable figure, whether it was the lowest bid, and — when it was not — the written reason it was not taken. Approval then comes from somebody who is neither the author nor the recommender."
          action={
            <Button
              onClick={() => setRecommendOpen(true)}
              disabled={comparison.candidates.length === 0}
            >
              Recommend an award
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {items.map((award) => (
            <AwardCard
              key={award.id}
              award={award}
              nameOf={nameOf}
              busy={action.busy}
              onAct={act}
              onAsk={ask}
            />
          ))}
        </div>
      )}

      <RecommendModal
        open={recommendOpen}
        projectId={projectId}
        packageId={packageId}
        candidates={comparison.candidates}
        lowest={comparison.lowest}
        basis={comparison.basis}
        onClose={() => setRecommendOpen(false)}
        onDone={() => {
          setRecommendOpen(false);
          refresh();
        }}
      />

      {dialog}
    </div>
  );
}

/* ================================================================== */
/* One award                                                           */
/* ================================================================== */

function AwardCard({
  award,
  nameOf,
  busy,
  onAct,
  onAsk,
}: {
  award: BidAward;
  nameOf: (id: string | null | undefined) => string;
  busy: string | null;
  onAct: (key: string, awardId: string, path: string, body?: unknown) => Promise<void>;
  onAsk: (req: {
    title: string;
    description?: string;
    confirmLabel?: string;
    destructive?: boolean;
    minLength?: number;
  }) => Promise<string | null>;
}) {
  const isLowest = award.audit.isLowestBid;
  const [loiCap, setLoiCap] = useState("");

  return (
    <Card accent={awardTone(award.status)}>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{award.reference}</span>
              <Badge tone={awardTone(award.status)} size="sm" dot>
                {titleCase(award.status)}
              </Badge>
              {award.commitmentId ? (
                <Badge tone="info" size="sm" icon={IconContract}>
                  Commitment created
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-meta text-content-muted">
              {award.vendorName ?? award.vendorId} · {money(award.awardAmount, award.currency)}
            </p>
          </div>
        </div>

        {/* ---------------- the two audit columns ---------------- */}
        <div
          className={cx(
            "rounded-lg border p-3",
            isLowest ? "border-success-border bg-success-subtle" : "border-warning-border bg-warning-subtle",
          )}
        >
          <p className="text-meta font-semibold">
            {isLowest
              ? "This was the lowest comparable bid."
              : "This was NOT the lowest comparable bid."}
          </p>
          <dl className="mt-1.5 grid gap-x-6 gap-y-1 text-meta sm:grid-cols-2">
            <div className="flex justify-between gap-3">
              <dt className="text-content-subtle">Recommended amount</dt>
              <dd className="font-medium tabular-nums">
                {money(award.awardAmount, award.currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-content-subtle">Lowest bid amount</dt>
              <dd className="font-medium tabular-nums">
                {award.audit.lowestBidAmount === null
                  ? "not recorded"
                  : money(award.audit.lowestBidAmount, award.currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-content-subtle">Compared on</dt>
              <dd className="font-medium">
                {typeof award.audit.comparisonBasis === "string"
                  ? titleCase(award.audit.comparisonBasis)
                  : "not stated"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-content-subtle">Against the estimate</dt>
              <dd className="font-medium tabular-nums">
                {award.audit.savingAgainstEstimate === null
                  ? "no estimate on record"
                  : money(award.audit.savingAgainstEstimate, award.currency)}
              </dd>
            </div>
          </dl>
          {!isLowest ? (
            <div className="mt-2 rounded-md bg-surface-raised p-2">
              <p className="text-label uppercase text-content-subtle">
                Why the lowest bid was not taken
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-meta">
                {award.audit.notLowestJustification ?? "—"}
              </p>
            </div>
          ) : null}
        </div>

        {award.recommendationBasis ? (
          <div>
            <p className="text-label uppercase text-content-subtle">The recommendation</p>
            <p className="mt-0.5 whitespace-pre-wrap text-meta text-content-muted">
              {award.recommendationBasis}
            </p>
          </div>
        ) : null}

        {award.warnings && award.warnings.length > 0 ? (
          <Alert tone="warning" title="Recorded alongside this award">
            <ReasonList reasons={award.warnings} tone="warning" />
          </Alert>
        ) : null}

        <DescriptionList
          columns={2}
          size="sm"
          items={[
            {
              label: "Recommended by",
              value: nameOf(award.audit.recommendedBy),
              hint: dateTime(award.audit.recommendedAt),
            },
            {
              label: "Approved by",
              value: award.audit.approvedBy ? nameOf(award.audit.approvedBy) : "not approved",
              hint: award.audit.approvedBy
                ? `${dateTime(award.audit.approvedAt)}${award.audit.segregated ? " — a different person from the recommender" : ""}`
                : "Approval is by somebody who is neither the author nor the recommender.",
              tone: award.audit.approvedBy
                ? award.audit.segregated
                  ? "success"
                  : "warning"
                : undefined,
            },
            {
              label: "Unsuccessful bidders told",
              value: award.audit.unsuccessfulNotifiedAt
                ? dateTime(award.audit.unsuccessfulNotifiedAt)
                : "not yet",
              hint: award.audit.unsuccessfulNotifiedAt
                ? undefined
                : "The standstill clock starts when they are told, not at approval — a period that runs before anyone has been told is not a period in which anyone can challenge.",
            },
            {
              label: "Standstill",
              value: award.standstill.endsAt ? dateTime(award.standstill.endsAt) : "none set",
              hint: award.standstill.note,
              tone: award.standstill.active ? "warning" : undefined,
            },
            {
              label: "Prequalification at this moment",
              value: titleCase(award.prequalification.state),
              hint: award.prequalification.note,
              span: 2,
            },
            ...(award.commitmentId
              ? [
                  {
                    label: "Commitment",
                    value: award.commitmentId,
                    hint: "Created in the commitments module — its own approval, compliance gates and payments are that module's business, not this one's.",
                    span: 2 as const,
                  },
                ]
              : []),
            ...(award.challengeReceived
              ? [
                  {
                    label: "Challenge received",
                    value: award.challengeNote ?? "recorded",
                    span: 2 as const,
                    tone: "danger" as const,
                  },
                ]
              : []),
            ...(award.rejectedReason
              ? [
                  {
                    label: "Rejected",
                    value: award.rejectedReason,
                    span: 2 as const,
                    tone: "danger" as const,
                  },
                ]
              : []),
          ]}
        />

        {/* ---------------- lifecycle ---------------- */}
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {award.status === "recommended" || award.status === "pending_approval" ? (
            <>
              <Button
                size="sm"
                loading={busy === `approve:${award.id}`}
                onClick={() => void onAct("approve", award.id, "approve")}
              >
                Approve — and create the commitment
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={busy === `reject:${award.id}`}
                onClick={() => {
                  void (async () => {
                    const reason = await onAsk({
                      title: "Reject this recommendation",
                      description:
                        "The reason is recorded on the award and in the ledger. Rejecting is not by the person who recommended.",
                      confirmLabel: "Reject",
                      destructive: true,
                    });
                    if (reason) await onAct("reject", award.id, "reject", { reason });
                  })();
                }}
              >
                Reject
              </Button>
            </>
          ) : null}

          {award.status === "approved" && !award.unsuccessfulNotifiedAt ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busy === `notify:${award.id}`}
              onClick={() => void onAct("notify", award.id, "notify-unsuccessful")}
            >
              Tell the unsuccessful bidders
            </Button>
          ) : null}

          {award.status === "approved" ? (
            <div className="flex items-end gap-2">
              <Field label="LOI cap" className="w-32">
                <Input
                  size="sm"
                  type="number"
                  inputMode="decimal"
                  value={loiCap}
                  onChange={(e) => setLoiCap(e.target.value)}
                />
              </Field>
              <Button
                size="sm"
                variant="ghost"
                disabled={!loiCap.trim()}
                loading={busy === `loi:${award.id}`}
                onClick={() =>
                  void onAct("loi", award.id, "letter-of-intent", { cap: Number(loiCap) })
                }
              >
                Issue a letter of intent
              </Button>
            </div>
          ) : null}

          {award.status === "approved" || award.status === "letter_of_intent" ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busy === `issue:${award.id}`}
              onClick={() => void onAct("issue", award.id, "contract-issued")}
            >
              Contract issued
            </Button>
          ) : null}

          {award.status === "contract_issued" || award.status === "letter_of_intent" ? (
            <Button
              size="sm"
              loading={busy === `execute:${award.id}`}
              onClick={() => void onAct("execute", award.id, "execute")}
            >
              Executed
            </Button>
          ) : null}

          {!award.debriefProvidedAt && award.unsuccessfulNotifiedAt ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === `debrief:${award.id}`}
              onClick={() => void onAct("debrief", award.id, "debrief")}
            >
              Record a debrief
            </Button>
          ) : null}

          {!award.challengeReceived ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === `challenge:${award.id}`}
              onClick={() => {
                void (async () => {
                  const note = await onAsk({
                    title: "Record a challenge",
                    description:
                      "The answer to a challenge is the record this module has been building all along: the levelling, the scores, the lowest bid amount and why it was not taken.",
                    confirmLabel: "Record it",
                  });
                  if (note) await onAct("challenge", award.id, "challenge", { note });
                })();
              }}
            >
              Record a challenge
            </Button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* Recommend                                                           */
/* ================================================================== */

function RecommendModal({
  open,
  projectId,
  packageId,
  candidates,
  lowest,
  basis,
  onClose,
  onDone,
}: {
  open: boolean;
  projectId: string;
  packageId: string;
  candidates: Candidate[];
  lowest: Candidate | null;
  basis: "levelled" | "as_bid";
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [submissionId, setSubmissionId] = useState("");
  const [recommendationBasis, setRecommendationBasis] = useState("");
  const [justification, setJustification] = useState("");
  const [standstillDays, setStandstillDays] = useState("10");
  const [authority, setAuthority] = useState("");

  const chosen = candidates.find((c) => c.submissionId === submissionId) ?? null;
  const isLowest =
    chosen !== null &&
    lowest !== null &&
    chosen.comparableAmount !== null &&
    lowest.comparableAmount !== null &&
    chosen.comparableAmount <= lowest.comparableAmount + 0.005;
  const needsJustification = chosen !== null && !isLowest;

  async function submit() {
    const body: Record<string, unknown> = {
      submissionId,
      recommendationBasis: recommendationBasis.trim(),
      standstillDays: Number(standstillDays) || 0,
    };
    if (needsJustification) body["notLowestJustification"] = justification.trim();
    if (authority.trim()) body["approvalAuthority"] = authority.trim();
    const done = await action.run("recommend", () =>
      api.post(
        `/api/v1/projects/${projectId}/bid-packages/${packageId}/award/recommend`,
        body,
      ),
    );
    if (done) onDone();
  }

  const blocked =
    !submissionId ||
    recommendationBasis.trim().length < 20 ||
    (needsJustification && justification.trim().length < 20);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Recommend an award"
      description={
        basis === "levelled"
          ? "Compared on levelled amounts — the like-for-like figures."
          : "Compared on as-bid totals — this package has not been levelled."
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={action.busy === "recommend"} disabled={blocked}>
            Record the recommendation
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

        <Field label="Which bid" required>
          <Select
            value={submissionId}
            onChange={(e) => setSubmissionId(e.target.value)}
            placeholder="Choose a bidder"
          >
            {candidates.map((c) => (
              <option key={c.submissionId} value={c.submissionId}>
                {c.vendorName} —{" "}
                {c.comparableAmount === null
                  ? "no comparable amount"
                  : money(c.comparableAmount, c.currency)}
              </option>
            ))}
          </Select>
        </Field>

        {lowest ? (
          <Alert
            tone={chosen === null ? "info" : isLowest ? "success" : "warning"}
            title={
              chosen === null
                ? `The lowest comparable bid is ${lowest.vendorName} at ${money(lowest.comparableAmount, lowest.currency)}`
                : isLowest
                  ? "This is the lowest comparable bid"
                  : "This is NOT the lowest comparable bid"
            }
          >
            {chosen !== null && !isLowest ? (
              <p>
                {lowest.vendorName} is lower at{" "}
                <strong>{money(lowest.comparableAmount, lowest.currency)}</strong>
                {chosen.comparableAmount !== null ? (
                  <>
                    {" "}
                    — a difference of{" "}
                    {money(
                      (chosen.comparableAmount ?? 0) - (lowest.comparableAmount ?? 0),
                      chosen.currency,
                    )}
                    {lowest.comparableAmount
                      ? ` (${num((((chosen.comparableAmount ?? 0) - lowest.comparableAmount) / lowest.comparableAmount) * 100, 1)}%)`
                      : null}
                  </>
                ) : null}
                . The lowest amount is recorded on the award whether or not it is taken.
              </p>
            ) : (
              <p>
                The lowest amount is recorded on the award whether or not it is taken — that is the
                auditor&rsquo;s anchor.
              </p>
            )}
          </Alert>
        ) : (
          <Alert tone="danger" title="No lowest bid can be named">
            Either no bid in contention carries a comparable amount, or the bids are priced in more
            than one currency. Either way the API will refuse a recommendation until it can say what
            the lowest bid was.
          </Alert>
        )}

        <Field
          label="Why this bid"
          required
          hint="At least 20 characters. This is the sentence the recommendation stands or falls on."
        >
          <Textarea
            rows={4}
            value={recommendationBasis}
            onChange={(e) => setRecommendationBasis(e.target.value)}
          />
        </Field>

        {needsJustification ? (
          <div className="rounded-lg border border-warning-border bg-warning-subtle p-3">
            <p className="text-meta font-semibold text-warning-fg">
              A recommendation that is not the lowest bid REQUIRES a written justification
            </p>
            <p className="mt-1 text-2xs text-content-muted">
              The API refuses this call without it. That record, alongside the lowest bid amount, is
              precisely what an auditor asks for, and it cannot be written afterwards.
            </p>
            <Field
              className="mt-2"
              label="Why the lowest bid was not taken"
              required
              hint="At least 20 characters."
            >
              <Textarea
                rows={4}
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
              />
            </Field>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Standstill (days)"
            hint="Runs from the moment the unsuccessful bidders are told. Nothing may be signed before it ends."
          >
            <Input
              type="number"
              inputMode="numeric"
              value={standstillDays}
              onChange={(e) => setStandstillDays(e.target.value)}
            />
          </Field>
          <Field label="Approval authority" optional hint="Who has to sign this off.">
            <Input value={authority} onChange={(e) => setAuthority(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
