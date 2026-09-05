/**
 * IFC Performance Standard 5 / World Bank ESS5 conformance rules (#558-560,
 * #568) — pure predicates over rows the caller has already loaded.
 *
 * These are the four hard rules a supervision mission tests, encoded so the
 * platform finds them before the mission does. Each returns a finding with
 * the paragraph it rests on, because an E&S finding without a citation is an
 * opinion:
 *
 *  (a) DISPLACEMENT BEFORE COMPENSATION — PS5 para 9: "displacement does not
 *      occur before necessary measures for resettlement are in place", and
 *      para 20: compensation is paid BEFORE displacement and before taking
 *      possession. A household recorded as resettled, or a parcel recorded as
 *      acquired, or a blocking task actually started, while compensation has
 *      not been paid, is the single most serious resettlement finding there
 *      is. It is also unfixable after the fact.
 *
 *  (b) VULNERABLE HOUSEHOLD WITHOUT ENHANCED ENTITLEMENT — PS5 para 8 and
 *      GN5: vulnerable households receive targeted assistance beyond the
 *      standard matrix. A household carrying a vulnerability flag whose
 *      entitlements contain nothing livelihood- or transition-shaped has been
 *      screened and then treated identically to everyone else, which is what
 *      screening is supposed to prevent.
 *
 *  (c) CUT-OFF NOT DISCLOSED — PS5 para 8 footnote 12 / ESS5 para 20: the
 *      cut-off date must be DISCLOSED to the affected communities. A cut-off
 *      declared in the register with no disclosure engagement on or after the
 *      declaration is a cut-off the community cannot be held to, and every
 *      "post-cut-off encroacher" rejection that rests on it is challengeable.
 *
 *  (d) LIVELIHOOD NOT RESTORED — PS5 para 29: livelihoods are restored, and
 *      monitoring continues until the restoration objectives are achieved.
 *      Twelve months after physical displacement is the conventional first
 *      test point; a household past it with no restoration record is the
 *      finding that turns into a completion-audit failure.
 *
 * Nothing here reads the database or writes a signal — the sweep does that.
 */

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface Ps5Parcel {
  id: string;
  reference: string;
  status: string;
  compensationPaidAt: string | null;
  acquisitionBasis: string | null;
  tenureType: string;
  blockingTaskIds: string[];
}

export interface Ps5Pap {
  id: string;
  reference: string;
  householdHead: string;
  status: string;
  displacementType: string;
  vulnerabilities: string[];
  entitlements: unknown[];
  compensationPaidAt: string | null;
  livelihoodRestoredAt: string | null;
}

export interface Ps5Task {
  id: string;
  name: string;
  actualStart: string | null;
}

export interface Ps5Engagement {
  id: string;
  kind: string;
  engagementDate: string;
}

export interface Ps5Finding {
  detector:
    | "displacement_before_compensation"
    | "vulnerable_household_without_enhanced_entitlement"
    | "cut_off_not_disclosed"
    | "livelihood_not_restored";
  /** deterministic identity of the finding */
  key: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  explanation: string;
  subjectType: string;
  subjectId: string;
  evidenceRefs: Record<string, unknown>;
}

/**
 * Acquisition bases that legitimately involve no cash compensation. A parcel
 * the state already held, or one donated after an informed, documented
 * process, is not "acquired without paying" — it is acquired on a basis the
 * register records. Purchase and expropriation always require payment.
 */
export const NON_CASH_ACQUISITION_BASES: readonly string[] = [
  "donation",
  "state_allocation",
  "court_order",
];

/** Entitlement items that count as an enhanced / transitional measure. */
const ENHANCED_ENTITLEMENT_HINTS = [
  "livelihood",
  "transition",
  "transitional",
  "training",
  "vulnerab",
  "resettlement assistance",
  "moving",
  "disturbance",
  "food",
  "allowance",
  "grant",
  "employment",
  "land for land",
  "replacement dwelling",
  "medical",
  "school",
];

interface EntitlementLike {
  item?: unknown;
  basis?: unknown;
}

/** True when at least one entitlement line reads as an enhanced measure. */
export function hasEnhancedEntitlement(entitlements: readonly unknown[]): boolean {
  for (const raw of entitlements) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as EntitlementLike;
    const text = `${typeof e.item === "string" ? e.item : ""} ${
      typeof e.basis === "string" ? e.basis : ""
    }`.toLowerCase();
    if (ENHANCED_ENTITLEMENT_HINTS.some((hint) => text.includes(hint))) return true;
  }
  return false;
}

/** Whole days between two ISO dates (date-only, UTC). */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/** Conventional first test point for livelihood restoration, in days. */
export const LIVELIHOOD_TEST_DAYS = 365;

/* ------------------------------------------------------------------ */
/* (a) displacement before compensation — PS5 para 9 / 20              */
/* ------------------------------------------------------------------ */

export function detectDisplacementBeforeCompensation(args: {
  parcels: readonly Ps5Parcel[];
  paps: readonly Ps5Pap[];
  tasksById: ReadonlyMap<string, Ps5Task>;
}): Ps5Finding[] {
  const out: Ps5Finding[] = [];

  for (const parcel of args.parcels) {
    const nonCash =
      parcel.acquisitionBasis != null &&
      NON_CASH_ACQUISITION_BASES.includes(parcel.acquisitionBasis);
    const started = parcel.blockingTaskIds
      .map((id) => args.tasksById.get(id))
      .filter((t): t is Ps5Task => Boolean(t?.actualStart));
    const takenPossession = parcel.status === "acquired";
    if (parcel.compensationPaidAt) continue;
    if (!takenPossession && started.length === 0) continue;
    // A donated or state parcel needs no payment; a purchased one always does.
    if (nonCash && started.length === 0) continue;

    const reason = takenPossession
      ? `the parcel is recorded as acquired`
      : `works on it have actually started ("${started[0]!.name}" on ${started[0]!.actualStart})`;
    out.push({
      detector: "displacement_before_compensation",
      key: `parcel:${parcel.id}`,
      severity: "critical",
      title: `Possession taken before compensation — parcel ${parcel.reference}`,
      explanation:
        `Parcel ${parcel.reference} (${parcel.tenureType} tenure) carries no compensation ` +
        `payment date, yet ${reason}. IFC Performance Standard 5 para 9 requires that ` +
        `displacement does not occur before the necessary resettlement measures are in place, ` +
        `and para 20 requires compensation to be paid before possession is taken. This is not ` +
        `a scheduling problem that a later payment fixes: taking possession first is the ` +
        `breach, and it is the finding a lender's supervision mission escalates.` +
        (parcel.acquisitionBasis
          ? ` The recorded acquisition basis is "${parcel.acquisitionBasis}".`
          : ` No acquisition basis has been recorded, so no non-cash basis excuses the absence ` +
            `of payment.`),
      subjectType: "land_parcel",
      subjectId: parcel.id,
      evidenceRefs: {
        parcelId: parcel.id,
        reference: parcel.reference,
        status: parcel.status,
        acquisitionBasis: parcel.acquisitionBasis,
        startedTaskIds: started.map((t) => t.id),
        citation: "IFC PS5 para 9, para 20",
      },
    });
  }

  for (const pap of args.paps) {
    if (pap.status !== "resettled") continue;
    if (pap.compensationPaidAt) continue;
    out.push({
      detector: "displacement_before_compensation",
      key: `pap:${pap.id}`,
      severity: "critical",
      title: `Household resettled before compensation — ${pap.reference}`,
      explanation:
        `Household ${pap.reference} (${pap.householdHead}, ${pap.displacementType} ` +
        `displacement) is recorded as resettled with no compensation payment on file. ` +
        `IFC PS5 para 20 requires compensation to be paid before the household is displaced. ` +
        `Either the payment record is missing — in which case the register is not evidence of ` +
        `anything — or the household was moved without being paid.`,
      subjectType: "affected_person",
      subjectId: pap.id,
      evidenceRefs: {
        papId: pap.id,
        reference: pap.reference,
        displacementType: pap.displacementType,
        citation: "IFC PS5 para 20",
      },
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* (b) vulnerable household without enhanced entitlement — PS5 para 8  */
/* ------------------------------------------------------------------ */

export function detectVulnerableWithoutEnhancement(paps: readonly Ps5Pap[]): Ps5Finding[] {
  const out: Ps5Finding[] = [];
  for (const pap of paps) {
    if (pap.vulnerabilities.length === 0) continue;
    // Nothing determined yet is a different (earlier) problem than
    // determined-and-identical; only flag once a matrix has been applied.
    if (pap.entitlements.length === 0) continue;
    if (hasEnhancedEntitlement(pap.entitlements)) continue;
    out.push({
      detector: "vulnerable_household_without_enhanced_entitlement",
      key: `pap:${pap.id}`,
      severity: "high",
      title: `Vulnerable household with no enhanced entitlement — ${pap.reference}`,
      explanation:
        `Household ${pap.reference} was screened as vulnerable ` +
        `(${pap.vulnerabilities.join(", ")}) but its entitlement matrix contains only ` +
        `standard items — nothing livelihood-, transition- or assistance-shaped. IFC PS5 ` +
        `para 8 and Guidance Note 5 require targeted assistance for vulnerable households ` +
        `precisely because the standard matrix leaves them worse off. Screening a household ` +
        `as vulnerable and then giving it the standard package is the failure mode the ` +
        `screening exists to prevent.`,
      subjectType: "affected_person",
      subjectId: pap.id,
      evidenceRefs: {
        papId: pap.id,
        reference: pap.reference,
        vulnerabilities: pap.vulnerabilities,
        entitlementCount: pap.entitlements.length,
        citation: "IFC PS5 para 8; GN5",
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* (c) cut-off not disclosed — PS5 para 8 fn 12 / ESS5 para 20         */
/* ------------------------------------------------------------------ */

export function detectCutOffNotDisclosed(args: {
  projectId: string;
  cutOffDate: string | null;
  declaredAt: string | null;
  engagements: readonly Ps5Engagement[];
}): Ps5Finding[] {
  if (!args.cutOffDate) return [];
  const declaredDay = args.declaredAt ? args.declaredAt.slice(0, 10) : args.cutOffDate;
  const disclosed = args.engagements.some(
    (e) => e.kind === "disclosure" && e.engagementDate >= declaredDay,
  );
  if (disclosed) return [];
  return [
    {
      detector: "cut_off_not_disclosed",
      key: `project:${args.projectId}:${args.cutOffDate}`,
      severity: "high",
      title: `Cut-off date ${args.cutOffDate} has not been disclosed to affected communities`,
      explanation:
        `A cut-off date of ${args.cutOffDate} is declared on this project (declared ` +
        `${declaredDay}), and the census register enforces it — households recorded after it ` +
        `are refused as encroachment. No engagement of kind "disclosure" has been logged on ` +
        `or after the declaration. IFC PS5 para 8 (footnote 12) and World Bank ESS5 para 20 ` +
        `require the cut-off to be disclosed to the affected communities; an undisclosed ` +
        `cut-off cannot be held against anyone, so every post-cut-off rejection resting on it ` +
        `is challengeable, and the challenge usually arrives as a grievance backlog.`,
      subjectType: "project",
      subjectId: args.projectId,
      evidenceRefs: {
        projectId: args.projectId,
        cutOffDate: args.cutOffDate,
        declaredAt: args.declaredAt,
        citation: "IFC PS5 para 8 fn 12; ESS5 para 20",
      },
    },
  ];
}

/* ------------------------------------------------------------------ */
/* (d) livelihood not restored — PS5 para 29                           */
/* ------------------------------------------------------------------ */

export function detectLivelihoodNotRestored(args: {
  paps: readonly Ps5Pap[];
  physicalDisplacementTypes: readonly string[];
  livelihoodRequiredTypes: readonly string[];
  today: string;
}): Ps5Finding[] {
  const out: Ps5Finding[] = [];
  for (const pap of args.paps) {
    const requiresLivelihood =
      args.livelihoodRequiredTypes.includes(pap.displacementType) ||
      args.physicalDisplacementTypes.includes(pap.displacementType);
    if (!requiresLivelihood) continue;
    if (pap.livelihoodRestoredAt || pap.status === "livelihood_restored") continue;
    // The clock starts at displacement, which the register dates by payment
    // (compensation precedes displacement) — no payment, no clock: that is
    // detector (a)'s finding, not this one.
    if (!pap.compensationPaidAt) continue;
    const elapsed = daysBetween(pap.compensationPaidAt, args.today);
    if (elapsed < LIVELIHOOD_TEST_DAYS) continue;
    out.push({
      detector: "livelihood_not_restored",
      key: `pap:${pap.id}`,
      severity: "high",
      title: `Livelihood not restored ${Math.floor(elapsed / 30)} months after displacement — ${pap.reference}`,
      explanation:
        `Household ${pap.reference} was compensated on ${pap.compensationPaidAt} ` +
        `(${pap.displacementType} displacement) — ${elapsed} days ago — and the register ` +
        `carries no livelihood restoration date. IFC PS5 para 29 requires livelihoods to be ` +
        `restored and monitoring to continue until the restoration objectives are achieved; ` +
        `twelve months after displacement is the conventional first test point and the one a ` +
        `completion audit uses. Either restoration happened and was never recorded, or the ` +
        `household is a year past displacement with its income unrestored.`,
      subjectType: "affected_person",
      subjectId: pap.id,
      evidenceRefs: {
        papId: pap.id,
        reference: pap.reference,
        compensationPaidAt: pap.compensationPaidAt,
        daysSinceDisplacement: elapsed,
        citation: "IFC PS5 para 29",
      },
    });
  }
  return out;
}
