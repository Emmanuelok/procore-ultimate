/**
 * THE CONTRACT SUMMARY — parties, sum, dates, terms, and the revised sum after
 * executed change orders.
 *
 * The contract sum is decomposed rather than asserted: original, plus the
 * change orders that have actually been executed, equals the revised sum —
 * with the priced-but-unsigned changes shown alongside it and deliberately
 * OUTSIDE it, because exposure that only appears once it is signed is exposure
 * nobody managed.
 */
import { Alert, Badge, Button, Card, CardBody } from "../../ui";
import { DescriptionList, type DescriptionItem } from "../../ui/data";
import {
  ComponentValue,
  IdentityList,
  MoneyStat,
  SovIdentityCard,
  isoDate,
  money,
  pct,
  statusToneOf,
  titleCase,
} from "./shared";
import type { ContractView, PrimeChange } from "./types";

export default function SummaryTab({
  contract,
  changes,
  vendorName,
  busy,
  onApprove,
  onExecute,
}: {
  contract: ContractView;
  changes: readonly PrimeChange[];
  vendorName: (id: string | null) => string;
  busy: string | null;
  onApprove: () => void;
  onExecute: () => void;
}) {
  const c = contract;
  const cur = c.currency;
  const terms = c.retainageTerms;

  const executed = changes.filter((x) => x.status === "executed");
  const pending = changes.filter(
    (x) =>
      x.status === "pending_pricing" ||
      x.status === "pending_in_house_review" ||
      x.status === "pending_owner_approval" ||
      x.status === "revise_and_resubmit",
  );

  const parties: DescriptionItem[] = [
    {
      label: "Owner",
      value: vendorName(c.ownerVendorId),
      hint: "The paying party, as a directory vendor.",
    },
    {
      label: "Contractor",
      value: vendorName(c.contractorVendorId),
      hint: "The contracting entity.",
    },
    {
      label: "Architect / certifier",
      value: vendorName(c.architectVendorId),
      hint: "Certification is a third party's act on an AIA-style application.",
    },
    { label: "Pricing", value: titleCase(c.pricingType) },
    { label: "Currency", value: cur },
    {
      label: "Standard-form contract",
      value: c.contractId ?? "no clause set linked",
    },
  ];

  const dates: DescriptionItem[] = [
    { label: "Contract date", value: isoDate(c.contractDate) },
    { label: "Start", value: isoDate(c.startDate) },
    { label: "Substantial completion", value: isoDate(c.substantialCompletionDate) },
    { label: "Actual completion", value: isoDate(c.actualCompletionDate) },
    { label: "Signed contract received", value: isoDate(c.signedContractReceivedDate) },
    {
      label: "Executed",
      value:
        c.executed === 1 ? (
          isoDate(c.executionDate)
        ) : (
          <span className="italic text-content-subtle">
            not executed — an unexecuted contract cannot be billed against
          </span>
        ),
    },
    { label: "Terminated", value: isoDate(c.terminationDate) },
    {
      label: "Payment terms",
      value: c.paymentTermsDays === null ? "not recorded" : `${c.paymentTermsDays} days`,
    },
  ];

  const retainage: DescriptionItem[] = [
    {
      label: "On completed work",
      value: pct(terms.workPercent),
      hint: "Withheld on the work half of every application.",
    },
    {
      label: "On stored material",
      value: pct(terms.materialsPercent),
      hint:
        terms.materialsPercent === terms.workPercent
          ? "Unstated in the contract detail, so it takes the same rate as work — the clause an owner's counsel would assume."
          : "Recorded separately from the work rate.",
    },
    {
      label: "Step-down threshold",
      value:
        terms.reductionThresholdPercent === null ? (
          <span className="italic text-content-subtle">no step-down clause recorded</span>
        ) : (
          `${pct(terms.reductionThresholdPercent)} complete`
        ),
    },
    {
      label: "Reduced rate",
      value:
        terms.reducedPercent === null ? (
          <span className="italic text-content-subtle">not recorded</span>
        ) : (
          pct(terms.reducedPercent)
        ),
      hint:
        terms.reducedPercent !== null
          ? "Once the threshold trips, the reduced rate applies to the retainage held TO DATE, so the over-withheld balance returns through line 6."
          : undefined,
    },
    { label: "Held now", value: money(c.retainageHeld, cur) },
    { label: "Released to date", value: money(c.retainageReleased, cur) },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusToneOf(c.status)} dot>
              {titleCase(c.status)}
            </Badge>
            <Badge tone={c.executed === 1 ? "success" : "warning"} variant="outline">
              {c.executed === 1 ? "Executed" : "Not executed"}
            </Badge>
            <span className="flex-1" />
            {c.status !== "approved" &&
            c.status !== "complete" &&
            c.status !== "void" &&
            c.status !== "terminated" ? (
              <Button size="sm" onClick={onApprove} disabled={busy !== null}>
                Approve
              </Button>
            ) : null}
            {c.status === "approved" && c.executed !== 1 ? (
              <Button size="sm" onClick={onExecute} disabled={busy !== null}>
                Record execution
              </Button>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <MoneyStat
              label="Original sum"
              value={c.originalContractSum}
              currency={cur}
              hint="Line 1 of every G702 raised against this contract."
            />
            <MoneyStat
              label="Executed changes"
              value={c.approvedChangeSum}
              currency={cur}
              hint={`${executed.length} executed change order${executed.length === 1 ? "" : "s"} — line 2.`}
            />
            <MoneyStat
              label="Revised sum"
              value={c.revisedContractSum}
              currency={cur}
              size="lg"
              hint="Line 3: original plus executed changes."
            />
            <MoneyStat
              label="Billed to date"
              value={c.totalBilled}
              currency={cur}
              hint={
                <ComponentValue
                  component={c.percentComplete}
                  render={(v) => `${pct(v)} complete`}
                />
              }
            />
            <MoneyStat label="Paid to date" value={c.totalPaid} currency={cur} />
            <MoneyStat
              label="Balance to finish"
              value={c.balanceToFinish}
              currency={cur}
              hint="Revised sum less billed to date."
            />
          </div>

          {pending.length > 0 ? (
            <Alert tone="warning" size="sm" title="Priced but not executed">
              {pending.length} change order{pending.length === 1 ? "" : "s"} worth{" "}
              {money(c.pendingChangeSum, cur)} {pending.length === 1 ? "is" : "are"} priced and
              unsigned. That value is deliberately OUTSIDE the revised contract sum above — it
              enters the sum only when the change order is executed, and only by appending schedule
              lines that keep the continuation sheet balanced.
              {c.draftChangeSum !== 0 ? (
                <span className="block">
                  A further {money(c.draftChangeSum, cur)} sits in draft.
                </span>
              ) : null}
            </Alert>
          ) : null}
        </CardBody>
      </Card>

      <SovIdentityCard
        sovTotal={c.sov.identity.sovTotal}
        contractSum={c.sov.identity.contractSum}
        currency={cur}
        ok={c.sov.identity.ok}
        message={c.sov.identity.message}
        legs={c.sov.identity.legs}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            <h3 className="mb-2 text-sm font-semibold">Parties</h3>
            <DescriptionList items={parties} columns={2} size="sm" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <h3 className="mb-2 text-sm font-semibold">Dates and execution</h3>
            <DescriptionList items={dates} columns={2} size="sm" />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardBody>
          <h3 className="mb-2 text-sm font-semibold">Retainage terms</h3>
          <DescriptionList items={retainage} columns={3} size="sm" />
        </CardBody>
      </Card>

      <IdentityList
        identities={c.identities}
        currency={cur}
        title="Identities checked on this contract"
      />

      <Prose title="Scope of work" body={c.scopeOfWork} />
      <div className="grid gap-4 md:grid-cols-2">
        <Prose title="Inclusions" body={c.inclusions} />
        <Prose title="Exclusions" body={c.exclusions} />
      </div>
    </div>
  );
}

function Prose({ title, body }: { title: string; body: string | null }) {
  return (
    <Card>
      <CardBody>
        <h3 className="text-sm font-semibold">{title}</h3>
        {body ? (
          <p className="mt-1 whitespace-pre-wrap text-meta text-content-muted">{body}</p>
        ) : (
          <p className="mt-1 text-meta italic text-content-subtle">
            Nothing is recorded here. That is not the same as nothing being agreed — it means this
            field is empty on the record.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
