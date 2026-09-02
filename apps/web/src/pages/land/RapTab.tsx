/**
 * Resettlement Action Plan dashboard (spec Domain J #558, #565, #567-568,
 * #591). This is the single view an IFC PS5 / World Bank ESS5 supervision
 * mission and an independent RAP monitor open first, and it answers their
 * four questions in order: how much land is actually held, how much
 * compensation actually reached beneficiaries, how many of the households
 * the scheme displaced have had their livelihoods restored — and which works
 * are about to start on land the project does not own.
 */
import { PARCEL_STATUSES } from "@constructos/shared";
import { Badge, Card, CardBody, EmptyState, Table, Td, Th } from "../../ui";
import { formatDate, humanize } from "../format";
import { HBars, Meter, StackedBar, type Datum } from "./charts";
import {
  fmtMoney,
  fmtNum,
  fmtPercent,
  parcelTone,
  startPhrase,
  type RapProgress,
  type ScheduleRisk,
} from "./landShared";

const VULNERABILITY_FLAGS = [
  "elderly",
  "disabled",
  "female_headed",
  "landless",
  "indigenous",
  "below_poverty_line",
  "child_headed",
] as const;

/** Acquisition pipeline order, so the stacked bar reads left-to-right as progress. */
const PARCEL_PIPELINE = [
  "identified",
  "surveyed",
  "under_negotiation",
  "agreed",
  "compensated",
  "acquired",
  "disputed",
] as const;

const PARCEL_TONE: Record<string, Datum["tone"]> = {
  identified: "soft",
  surveyed: "soft",
  under_negotiation: "brand",
  agreed: "brand",
  compensated: "brand",
  acquired: "green",
  disputed: "red",
};

function Stat({
  label,
  value,
  sub,
  tone,
  emphasized,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "red" | "amber" | "green" | "brand";
  emphasized?: boolean;
}) {
  const cls =
    tone === "red"
      ? "text-red-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "green"
          ? "text-emerald-700"
          : tone === "brand"
            ? "text-brand-700"
            : "text-ink-900";
  return (
    <Card className={emphasized ? "ring-1 ring-brand-200" : undefined}>
      <CardBody className="px-4 py-3">
        <div className={`${emphasized ? "text-2xl" : "text-xl"} font-bold tabular-nums ${cls}`}>
          {value}
        </div>
        <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-400">
          {label}
        </div>
        {sub ? <div className="mt-1 text-xs tabular-nums text-ink-500">{sub}</div> : null}
      </CardBody>
    </Card>
  );
}

export default function RapTab({
  rap,
  risk,
  onOpenParcel,
}: {
  rap: RapProgress | null;
  risk: ScheduleRisk | null;
  onOpenParcel: (parcelId: string) => void;
}) {
  if (!rap) {
    return (
      <EmptyState
        title="RAP progress is not available"
        hint="The resettlement dashboard is computed from the parcel and household registers. It reappears as soon as the workspace can read them."
      />
    );
  }

  const papsCompensated = ["compensated", "resettled", "livelihood_restored"].reduce(
    (s, k) => s + (rap.paps.byStatus[k] ?? 0),
    0,
  );
  const papsCompensatedPercent =
    rap.paps.total > 0 ? (papsCompensated / rap.paps.total) * 100 : null;

  const parcelData: Datum[] = PARCEL_PIPELINE.filter((s) =>
    (PARCEL_STATUSES as readonly string[]).includes(s),
  ).map((s) => ({
    key: s,
    label: humanize(s),
    value: rap.parcels.byStatus[s] ?? 0,
    tone: PARCEL_TONE[s] ?? "brand",
  }));

  const vulnerabilityData: Datum[] = VULNERABILITY_FLAGS.map((f) => ({
    key: f,
    label: humanize(f),
    value: rap.byVulnerability[f] ?? 0,
  }));

  // Anything inside the signal horizon is what the banner is actually for.
  const imminentItems = risk
    ? risk.items.filter((i) => i.daysUntilStart <= risk.signalHorizonDays)
    : [];

  return (
    <div className="space-y-4">
      {/* ------------------------ consent-to-programme (#591) ----------------------- */}
      {risk === null ? null : imminentItems.length > 0 ? (
        <div className="rounded-lg bg-red-50 p-4 ring-1 ring-red-200">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-red-800">
              Works about to start on land the project does not hold
              <span className="ml-1.5 font-normal text-red-500">(#591)</span>
            </h3>
            <span className="text-xs text-red-700">
              <span className="font-semibold tabular-nums">{imminentItems.length}</span> task
              {imminentItems.length === 1 ? "" : "s"} inside {risk.signalHorizonDays} days
              {risk.alreadyStarted > 0 ? (
                <> · {risk.alreadyStarted} already started</>
              ) : null}
              {risk.blockedTasks > imminentItems.length ? (
                <>
                  {" · "}
                  {risk.blockedTasks - imminentItems.length} further beyond the horizon
                </>
              ) : null}
            </span>
          </div>
          <p className="mb-3 max-w-3xl text-xs text-red-700">
            Each row is a schedule task whose land is still in acquisition. Starting works on land
            the project has not lawfully acquired is the classic route to an injunction, a
            community blockade and a lender safeguards finding — and the delay is almost never
            recoverable from the contractor.
          </p>
          <Table>
            <thead>
              <tr>
                <Th>Parcel</Th>
                <Th>Acquisition status</Th>
                <Th>Blocked task</Th>
                <Th>Planned start</Th>
                <Th className="text-right">Countdown</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {imminentItems.map((r) => (
                <tr key={`${r.parcelId}-${r.taskId}`} className="hover:bg-red-50/60">
                  <Td>
                    <button
                      type="button"
                      className="font-medium text-brand-700 hover:text-brand-800"
                      onClick={() => onOpenParcel(r.parcelId)}
                    >
                      {r.reference}
                    </button>
                    {r.ownerName ? (
                      <span className="ml-1.5 text-xs text-ink-400">{r.ownerName}</span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={parcelTone(r.status)}>{humanize(r.status)}</Badge>
                  </Td>
                  <Td className="max-w-xs truncate">{r.taskName}</Td>
                  <Td className="tabular-nums">{formatDate(r.taskStart)}</Td>
                  <Td className="text-right font-medium tabular-nums text-red-700">
                    {startPhrase(r.daysUntilStart)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : risk.blockedTasks > 0 ? (
        <Card className="ring-1 ring-amber-200">
          <CardBody className="flex flex-wrap items-center gap-2 py-3 text-sm">
            <Badge tone="amber">Watch</Badge>
            <span className="text-ink-700">
              <span className="font-semibold tabular-nums">{risk.blockedTasks}</span> task
              {risk.blockedTasks === 1 ? "" : "s"} across {risk.blockedParcels} parcel
              {risk.blockedParcels === 1 ? "" : "s"} still depend on land in acquisition, but none
              starts inside {risk.signalHorizonDays} days.
            </span>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="flex flex-wrap items-center gap-2 py-3 text-sm">
            <Badge tone="green">Clear</Badge>
            <span className="text-ink-600">
              No works inside the next {risk.horizonDays} days depend on land the project has not
              acquired.
            </span>
          </CardBody>
        </Card>
      )}

      {/* --------------------------------- headline -------------------------------- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Parcels acquired"
          value={fmtPercent(rap.readyForConstructionPercent)}
          sub={`${fmtNum(rap.parcels.acquired)} of ${fmtNum(rap.parcels.total)}`}
          tone="brand"
          emphasized
        />
        <Stat
          label="Households compensated"
          value={fmtPercent(papsCompensatedPercent)}
          sub={`${fmtNum(papsCompensated)} of ${fmtNum(rap.paps.total)}`}
          tone="brand"
          emphasized
        />
        <Stat
          label="Physically displaced"
          value={fmtNum(rap.physicallyDisplaced)}
          sub="households losing shelter"
        />
        <Stat
          label="Economically displaced"
          value={fmtNum(rap.economicallyDisplaced)}
          sub="households losing income"
        />
        <Stat
          label="Vulnerable households"
          value={fmtNum(rap.vulnerableHouseholds)}
          sub="enhanced entitlements (#557)"
          tone={rap.vulnerableHouseholds > 0 ? "amber" : undefined}
        />
        <Stat
          label="Livelihood restored"
          value={fmtPercent(rap.livelihoodRestoredPercent)}
          sub={`${fmtNum(rap.livelihoodRestored)} of ${fmtNum(rap.livelihoodRequired)} required`}
          tone={
            rap.livelihoodRequired > 0 && rap.livelihoodRestored === rap.livelihoodRequired
              ? "green"
              : undefined
          }
        />
      </div>

      {/* -------------------------------- pipelines -------------------------------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink-900">
                Land acquisition pipeline{" "}
                <span className="font-normal text-ink-400">(#551)</span>
              </h3>
              <span className="text-xs tabular-nums text-ink-500">
                {fmtNum(rap.parcels.total)} parcels · {fmtNum(rap.parcels.areaSqm)} m²
              </span>
            </div>
            <StackedBar
              ariaLabel="Land parcels by acquisition status"
              data={parcelData}
              emptyNote="No parcels registered yet."
            />

            <div className="mt-5 space-y-3 border-t border-ink-100 pt-4">
              <div>
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-xs">
                  <span className="font-medium text-ink-700">
                    Compensation paid vs committed{" "}
                    <span className="font-normal text-ink-400">(#553, #567)</span>
                  </span>
                  <span className="tabular-nums text-ink-500">
                    {fmtMoney(rap.compensationPaid)} of {fmtMoney(rap.compensationCommitted)}
                  </span>
                </div>
                <Meter
                  value={rap.compensationPaid}
                  max={rap.compensationCommitted}
                  tone="brand"
                  caption={
                    <span className="tabular-nums">
                      {rap.compensationOutstanding > 0 ? (
                        <>
                          <span className="font-medium text-amber-700">
                            {fmtMoney(rap.compensationOutstanding)} outstanding
                          </span>
                          {" · "}
                        </>
                      ) : null}
                      landowners {fmtMoney(rap.compensation.parcels.paid)}/
                      {fmtMoney(rap.compensation.parcels.committed)} · households{" "}
                      {fmtMoney(rap.compensation.paps.paid)}/
                      {fmtMoney(rap.compensation.paps.committed)}
                    </span>
                  }
                />
              </div>
              <div>
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-xs">
                  <span className="font-medium text-ink-700">
                    Livelihood restoration{" "}
                    <span className="font-normal text-ink-400">(#561)</span>
                  </span>
                  <span className="tabular-nums text-ink-500">
                    {fmtNum(rap.livelihoodRestored)} of {fmtNum(rap.livelihoodRequired)} ·{" "}
                    {fmtPercent(rap.livelihoodRestoredPercent)}
                  </span>
                </div>
                <Meter
                  value={rap.livelihoodRestored}
                  max={rap.livelihoodRequired}
                  tone="green"
                  caption={
                    rap.livelihoodRequired === 0 ? (
                      <span>
                        No household is economically displaced, so no livelihood restoration
                        programme is required.
                      </span>
                    ) : null
                  }
                />
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <h3 className="mb-2 text-sm font-semibold text-ink-900">
              Vulnerability screening <span className="font-normal text-ink-400">(#557)</span>
            </h3>
            {rap.vulnerableHouseholds === 0 ? (
              <p className="py-6 text-center text-xs text-ink-400">
                No household on the register carries a vulnerability flag yet. Under IFC PS5 these
                households attract enhanced entitlements and targeted livelihood support — screen
                before entitlements are agreed, not after.
              </p>
            ) : (
              <>
                <p className="mb-2 text-xs text-ink-500">
                  <span className="font-semibold tabular-nums text-ink-800">
                    {fmtNum(rap.vulnerableHouseholds)}
                  </span>{" "}
                  of {fmtNum(rap.paps.total)} households carry at least one flag.
                </p>
                <HBars
                  ariaLabel="Households by vulnerability flag"
                  data={vulnerabilityData}
                  labelWidth={160}
                />
              </>
            )}
          </CardBody>
        </Card>
      </div>

      {/* --------------------------------- census ---------------------------------- */}
      <Card>
        <CardBody className="flex flex-wrap items-center gap-x-8 gap-y-3">
          {[
            ["Households censused", fmtNum(rap.paps.total)],
            ["People in those households", fmtNum(rap.paps.households)],
            ["Land area registered", `${fmtNum(rap.parcels.areaSqm)} m²`],
            [
              "Cut-off date",
              rap.cutOffDate ? formatDate(rap.cutOffDate) : "Not declared",
            ],
          ].map(([k, v]) => (
            <div key={k}>
              <div className="text-lg font-semibold tabular-nums text-ink-900">{v}</div>
              <div className="text-xs uppercase tracking-wide text-ink-400">{k}</div>
            </div>
          ))}
          {!rap.cutOffDate ? (
            <p className="max-w-md text-xs text-amber-700">
              Until a cut-off date is declared and disclosed, the entitlement population can be
              inflated after the fact — declare it on the households tab.
            </p>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
