/**
 * The detector registry (spec Vol II Domain A, Vol III §6).
 *
 * One place that says, for every detector this platform runs: what family it
 * belongs to, what it needs to run, what it costs to be wrong about, what its
 * thresholds are and which spec function it implements. The registry is what
 * makes the detector programme reviewable as a programme rather than as a pile
 * of functions — an operator can see the whole surface, enable and disable
 * parts of it, and read a measured precision figure next to each one.
 *
 * `scope` decides where a run can raise a signal: `project` detectors read one
 * project's records, `company` detectors look across the tenant (the entity
 * network, the payables population, the ledger itself) and raise signals with
 * a null projectId.
 */
import type { DetectorFamily, DetectorRunScope } from "@constructos/shared";

export interface DetectorDescriptor {
  id: string;
  family: DetectorFamily;
  scope: DetectorRunScope;
  name: string;
  /** what it tests, in one sentence a non-engineer can act on */
  description: string;
  /** spec function reference */
  specRef: string;
  /** data it needs — shown when a run skips it for want of that data */
  requires: string[];
  /** tunables the policy may override */
  defaultThresholds: Record<string, number>;
  /**
   * Suppress below this measured precision. Null means "never suppress
   * automatically" — reserved for detectors whose finding is arithmetic
   * rather than statistical (a broken chain is not a matter of opinion).
   */
  defaultPrecisionFloor: number | null;
}

export const DETECTOR_REGISTRY: DetectorDescriptor[] = [
  /* ---------------- value integrity ---------------- */
  {
    id: "benford_first_digit",
    family: "value_integrity",
    scope: "project",
    name: "Benford first-digit deviation",
    description:
      "Chi-square test of the first-digit distribution of cost and quantity claims against " +
      "Benford's Law. Fabricated value populations flatten the curve.",
    specRef: "Domain A #58",
    requires: ["at least 30 numeric cost/quantity assertions"],
    defaultThresholds: { mediumChiSquare: 20, highChiSquare: 30, minSample: 30 },
    defaultPrecisionFloor: 0.3,
  },
  {
    id: "duplicate_assertions",
    family: "value_integrity",
    scope: "project",
    name: "Duplicate claims",
    description:
      "The same claimant asserting the same kind, value and unit more than once inside 30 days.",
    specRef: "Domain A #55-56",
    requires: ["assertions with values"],
    defaultThresholds: { windowDays: 30 },
    defaultPrecisionFloor: 0.4,
  },
  {
    id: "round_number_clustering",
    family: "value_integrity",
    scope: "project",
    name: "Round-number clustering",
    description: "An implausible share of claim values landing on round hundreds or thousands.",
    specRef: "Domain A #57",
    requires: ["at least 10 numeric assertions"],
    defaultThresholds: { share: 0.4, minSample: 10 },
    defaultPrecisionFloor: 0.3,
  },
  /* ---------------- approval controls ---------------- */
  {
    id: "approval_velocity",
    family: "approval_controls",
    scope: "project",
    name: "Rubber-stamp approvals",
    description: "Approvals decided seconds after assignment, repeatedly, by the same approver.",
    specRef: "Domain A #37",
    requires: ["workflow step instances with decisions"],
    defaultThresholds: { maxSeconds: 60, minCount: 3 },
    defaultPrecisionFloor: 0.4,
  },
  {
    id: "segregation_of_duties",
    family: "approval_controls",
    scope: "project",
    name: "Self-approval",
    description: "The initiator of a workflow approving one of its own steps.",
    specRef: "Domain A #39-40",
    requires: ["workflow instances and steps"],
    defaultThresholds: {},
    defaultPrecisionFloor: null,
  },
  {
    id: "out_of_hours_approval",
    family: "approval_controls",
    scope: "company",
    name: "Out-of-hours approvals",
    description:
      "Approvals decided outside configured working hours or at weekends, repeatedly, by the " +
      "same approver.",
    specRef: "Domain A #34",
    requires: ["approved invoices or workflow steps with decision timestamps"],
    defaultThresholds: { startHour: 7, endHour: 19, minCount: 3, tzOffsetMinutes: 0 },
    defaultPrecisionFloor: 0.25,
  },
  {
    id: "approver_vendor_affinity",
    family: "approval_controls",
    scope: "company",
    name: "Approver–vendor affinity",
    description:
      "One approver signing off nearly all of one supplier's spend while handling little else.",
    specRef: "Domain A #38",
    requires: ["at least 8 vendor-attributed approvals"],
    defaultThresholds: { vendorShare: 0.9, minVendorApprovals: 5 },
    defaultPrecisionFloor: 0.4,
  },
  {
    id: "authority_limit_breach",
    family: "approval_controls",
    scope: "company",
    name: "Delegation-of-authority breach",
    description: "An approval above the approver's recorded authority limit.",
    specRef: "Domain A #41",
    requires: ["authority limits recorded for approvers"],
    defaultThresholds: {},
    defaultPrecisionFloor: null,
  },
  /* ---------------- entity network ---------------- */
  {
    id: "shared_identifier",
    family: "entity_network",
    scope: "company",
    name: "Shared identifiers between entities",
    description:
      "Nominally independent entities sharing a bank account, address, phone or email domain.",
    specRef: "Domain A #9, #44",
    requires: ["entities with identifiers"],
    defaultThresholds: {},
    defaultPrecisionFloor: 0.35,
  },
  {
    id: "undeclared_conflict",
    family: "entity_network",
    scope: "company",
    name: "Undeclared conflict of interest",
    description:
      "A path in the entity graph from an approver to a supplier they approved, with no matching " +
      "declaration on the conflict register.",
    specRef: "Domain A #45-47",
    requires: ["entity relationships linking users to entities", "vendor-attributed approvals"],
    defaultThresholds: { maxDepth: 3 },
    defaultPrecisionFloor: null,
  },
  {
    id: "shell_company_indicators",
    family: "entity_network",
    scope: "company",
    name: "Shell-company indicators",
    description:
      "An entity incorporated shortly before it first won work, with a single client and no " +
      "independent trading history.",
    specRef: "Domain A #48-52",
    requires: ["entity incorporation dates", "commitments"],
    defaultThresholds: { incorporationWindowDays: 180 },
    defaultPrecisionFloor: 0.3,
  },
  {
    id: "entity_screening_hit",
    family: "entity_network",
    scope: "company",
    name: "Sanctions / debarment / PEP match",
    description:
      "An entity whose name matches a designated party on a screening list snapshot.",
    specRef: "Domain A #10, #42-43",
    requires: ["a screening list snapshot (fixture or live feed)"],
    defaultThresholds: { matchFloor: 0.6 },
    defaultPrecisionFloor: null,
  },
  /* ---------------- certification ---------------- */
  {
    id: "contradicted_claimant",
    family: "certification",
    scope: "project",
    name: "Repeatedly contradicted claimant",
    description: "A claimant whose assertions independent evidence has contradicted twice or more.",
    specRef: "Domain A #66",
    requires: ["reconciliations"],
    defaultThresholds: { minContradictions: 2 },
    defaultPrecisionFloor: 0.5,
  },
  {
    id: "certified_above_evidenced",
    family: "certification",
    scope: "project",
    name: "Certified above what was evidenced",
    description:
      "An assertion whose typed reconciliation places the claim materially above the independent " +
      "observation, in the adverse direction.",
    specRef: "Domain A #65-71",
    requires: ["assertions with values", "independent evidence of an accepted kind"],
    defaultThresholds: { minVariancePercent: 15 },
    defaultPrecisionFloor: 0.5,
  },
  /* ---------------- ghost vendor ---------------- */
  {
    id: "vendor_person_identity_collision",
    family: "ghost_vendor",
    scope: "company",
    name: "Vendor shares identity with a person on the register",
    description:
      "A supplier whose address, email or phone matches a user, contact or worker the " +
      "organisation already pays.",
    specRef: "Domain A #53-54",
    requires: ["vendors with contact details", "users/contacts/workers"],
    defaultThresholds: {},
    defaultPrecisionFloor: null,
  },
  {
    id: "sequential_invoice_numbers",
    family: "ghost_vendor",
    scope: "company",
    name: "Consecutive supplier invoice numbers",
    description: "A run of consecutive invoice numbers from one supplier — we are their only customer.",
    specRef: "Domain A #55",
    requires: ["invoices carrying the supplier's own invoice number"],
    defaultThresholds: { sequentialRun: 4 },
    defaultPrecisionFloor: 0.35,
  },
  {
    id: "split_invoicing",
    family: "ghost_vendor",
    scope: "company",
    name: "Split invoicing under an approval threshold",
    description: "Several invoices just under an approval limit that together exceed it.",
    specRef: "Domain A #56",
    requires: ["an approval threshold on the detector policy or authority limits"],
    defaultThresholds: { splitBand: 0.75, windowDays: 30 },
    defaultPrecisionFloor: 0.4,
  },
  {
    id: "invoice_before_purchase_order",
    family: "ghost_vendor",
    scope: "company",
    name: "Invoice dated before its order",
    description: "An invoice dated earlier than the commitment that authorised the spend.",
    specRef: "Domain A #57",
    requires: ["invoices linked to commitments, both dated"],
    defaultThresholds: {},
    defaultPrecisionFloor: null,
  },
  {
    id: "dormant_vendor_reactivated",
    family: "ghost_vendor",
    scope: "company",
    name: "Dormant supplier reactivated",
    description: "A supplier billing again after a long period of no activity.",
    specRef: "Domain A #59",
    requires: ["at least two dated invoices per supplier"],
    defaultThresholds: { dormantDays: 365 },
    defaultPrecisionFloor: 0.25,
  },
  {
    id: "duplicate_payment",
    family: "ghost_vendor",
    scope: "company",
    name: "Duplicate payment",
    description: "The same supplier, the same amount, days apart.",
    specRef: "Domain A #60",
    requires: ["invoices with amounts and dates"],
    defaultThresholds: { windowDays: 7 },
    defaultPrecisionFloor: 0.4,
  },
  {
    id: "round_sum_invoicing",
    family: "ghost_vendor",
    scope: "company",
    name: "Round-sum invoicing by supplier",
    description: "A supplier whose invoices are overwhelmingly exact multiples of 1,000.",
    specRef: "Domain A #58",
    requires: ["at least 5 invoices from the supplier"],
    defaultThresholds: { roundShare: 0.6 },
    defaultPrecisionFloor: 0.3,
  },
  {
    id: "vendor_concentration",
    family: "ghost_vendor",
    scope: "company",
    name: "Supplier concentration",
    description: "One supplier holding a majority of spend in a currency across three or more suppliers.",
    specRef: "Domain A #61",
    requires: ["invoices from at least three suppliers in one currency"],
    defaultThresholds: { concentrationShare: 0.5 },
    defaultPrecisionFloor: 0.2,
  },
  /* ---------------- backdating ---------------- */
  {
    id: "backdated_record",
    family: "backdating",
    scope: "project",
    name: "Backdated record",
    description:
      "Assertions, events or evidence whose stated date precedes the moment they were written by " +
      "more than the configured window.",
    specRef: "Domain A #104",
    requires: ["assertions, events or evidence"],
    defaultThresholds: { windowHours: 72 },
    defaultPrecisionFloor: 0.3,
  },
  {
    id: "administrative_override",
    family: "backdating",
    scope: "company",
    name: "Administrative override",
    description:
      "Updates and deletes against high-value object types by actors holding no assurance role.",
    specRef: "Domain S #865-868",
    requires: ["ledger entries"],
    defaultThresholds: { minCount: 3 },
    defaultPrecisionFloor: 0.25,
  },
  /* ---------------- chain integrity (raised by the anchoring module) ---- */
  {
    id: "ledger_truncation_detected",
    family: "chain_integrity",
    scope: "company",
    name: "Ledger truncation",
    description: "Sealed entries are missing from the live chain.",
    specRef: "Domain S #860-861",
    requires: ["at least one chain seal"],
    defaultThresholds: {},
    defaultPrecisionFloor: null,
  },
  {
    id: "chain_seal_broken",
    family: "chain_integrity",
    scope: "company",
    name: "Seal chain broken",
    description: "A seal has been removed or relinked.",
    specRef: "Domain S #864",
    requires: ["at least one chain seal"],
    defaultThresholds: {},
    defaultPrecisionFloor: null,
  },
  {
    id: "chain_seal_forged",
    family: "chain_integrity",
    scope: "company",
    name: "Seal signature invalid",
    description: "A seal does not verify against the key it was made under.",
    specRef: "Domain S #864",
    requires: ["at least one chain seal"],
    defaultThresholds: {},
    defaultPrecisionFloor: null,
  },
  {
    id: "ledger_entry_altered",
    family: "chain_integrity",
    scope: "company",
    name: "Ledger entry altered",
    description: "An entry inside a sealed range no longer hashes to its recorded value.",
    specRef: "Domain S #859-861",
    requires: ["at least one chain seal"],
    defaultThresholds: {},
    defaultPrecisionFloor: null,
  },
  {
    id: "evidence_content_mismatch",
    family: "chain_integrity",
    scope: "project",
    name: "Evidence file no longer matches its hash",
    description:
      "A stored evidence file re-hashed on retrieval does not match the content hash recorded " +
      "when it was ingested.",
    specRef: "Domain S #862",
    requires: ["evidence with attached files"],
    defaultThresholds: {},
    defaultPrecisionFloor: null,
  },
  {
    id: "heartbeat_overdue",
    family: "chain_integrity",
    scope: "company",
    name: "Seal heartbeat overdue",
    description:
      "No seal has been written within the heartbeat interval, so the window in which the tail " +
      "could be cut invisibly is no longer bounded.",
    specRef: "Domain S #861",
    requires: ["at least one chain seal"],
    defaultThresholds: {},
    defaultPrecisionFloor: null,
  },
];

const BY_ID = new Map(DETECTOR_REGISTRY.map((d) => [d.id, d]));

export function detectorById(id: string): DetectorDescriptor | undefined {
  return BY_ID.get(id);
}

/** Detector ids a run of this scope may execute. */
export function detectorsForScope(scope: DetectorRunScope): DetectorDescriptor[] {
  return DETECTOR_REGISTRY.filter((d) => d.scope === scope && d.family !== "chain_integrity");
}

/** Detector ids that a run never executes (they are raised by other paths). */
export const PASSIVE_DETECTORS = new Set(
  DETECTOR_REGISTRY.filter((d) => d.family === "chain_integrity").map((d) => d.id),
);
