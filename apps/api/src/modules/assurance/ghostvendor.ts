/**
 * The ghost-vendor / payables detector family (spec Vol II Domain A #53-71,
 * plus the approval-pattern detectors #34-41).
 *
 * WHAT THIS IS. A fictitious or captured supplier does not announce itself.
 * It shows up as a set of small statistical oddities in the payables record:
 * an address that belongs to a member of staff, invoice numbers that run
 * consecutively because we are the shell's only customer, amounts that sit
 * just under somebody's approval limit, a payment that arrives before the
 * purchase order that supposedly authorised it, a supplier dormant for a year
 * that is suddenly paid, the same amount paid twice, approvals granted at
 * 03:00, one approver who signs off almost everything for one supplier.
 *
 * None of these is proof. Each is a QUESTION with an arithmetic basis, which
 * is the only kind of accusation this platform is willing to make: every
 * draft carries the numbers it was computed from, so a reviewer can dismiss
 * it on the evidence rather than on faith.
 *
 * Everything here is PURE — plain rows in, signal drafts out, no database, no
 * clock of its own (a `now` is always passed). That is what makes the
 * thresholds testable against planted schemes in `scripts/retrodetect.ts`.
 *
 * DELIBERATELY NOT HERE: anything that needs a live external list (sanctions
 * screening is `screening.ts`), and the procurement/bid-rigging family
 * (Domain A #1-35), which belongs to the bidding module's own detector pack.
 */
import type { SignalSeverity } from "@constructos/shared";
import { fingerprintOf, sortedIds, type SignalDraft } from "./detectors.js";

/* ------------------------------------------------------------------ */
/* Row shapes — the minimum each detector needs                        */
/* ------------------------------------------------------------------ */

export interface VendorLike {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  status: string;
  createdAt: string;
}

export interface PersonLike {
  id: string;
  kind: "user" | "contact" | "worker";
  name: string;
  address: string | null;
  email: string | null;
  phone: string | null;
}

export interface InvoiceLike {
  id: string;
  reference: string;
  vendorId: string | null;
  /** the supplier's own printed invoice number */
  invoiceNumber: string | null;
  commitmentId: string | null;
  currency: string;
  total: number;
  billingDate: string | null;
  receivedDate: string | null;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface CommitmentLike {
  id: string;
  reference: string;
  vendorId: string | null;
  contractDate: string | null;
  executionDate: string | null;
  currency: string;
}

export interface AuthorityLimitLike {
  userId: string;
  objectType: string;
  maxAmount: number;
  currency: string;
}

export interface GhostVendorThresholds {
  /** consecutive supplier invoice numbers before it becomes a finding */
  sequentialRun: number;
  /** an approval threshold amounts are suspected of being split under */
  approvalThreshold: number | null;
  /** how close to the threshold counts as "just under" (0..1) */
  splitBand: number;
  /** days of no activity that make a supplier dormant */
  dormantDays: number;
  /** duplicate payment window in days */
  duplicateWindowDays: number;
  /** share of a vendor's invoices that must be round before it fires */
  roundShare: number;
  /** working hours, local to `tzOffsetMinutes`, as [startHour, endHour) */
  workingHours: [number, number];
  tzOffsetMinutes: number;
  /** out-of-hours approvals by one approver before it fires */
  outOfHoursCount: number;
  /** share of one vendor's approvals by one approver before affinity fires */
  affinityShare: number;
  /** share of spend by one vendor before concentration fires */
  concentrationShare: number;
}

export const GHOST_VENDOR_DEFAULTS: GhostVendorThresholds = {
  sequentialRun: 4,
  approvalThreshold: null,
  splitBand: 0.75,
  dormantDays: 365,
  duplicateWindowDays: 7,
  roundShare: 0.6,
  workingHours: [7, 19],
  tzOffsetMinutes: 0,
  outOfHoursCount: 3,
  affinityShare: 0.9,
  concentrationShare: 0.5,
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** Normalise a free-text identifier so "12 High St." and "12 high st" match. */
export function normaliseIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = value
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\b(street|st|road|rd|avenue|ave|lane|ln|suite|ste|unit|apt|floor|fl)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length >= 4 ? t : null;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

const DAY_MS = 86_400_000;

/** Trailing integer of an invoice number, with its non-numeric prefix. */
export function invoiceNumberParts(
  value: string | null | undefined,
): { prefix: string; n: number } | null {
  if (!value) return null;
  const m = /^(.*?)(\d{1,12})\s*$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isFinite(n)) return null;
  return { prefix: (m[1] ?? "").toLowerCase().trim(), n };
}

function money(n: number, currency: string): string {
  return `${currency} ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function byVendor<T extends { vendorId: string | null }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.vendorId) continue;
    const list = out.get(r.vendorId) ?? [];
    list.push(r);
    out.set(r.vendorId, list);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* #53-54 vendor identity collides with a person on the payroll        */
/* ------------------------------------------------------------------ */

/**
 * A supplier whose registered address, email or phone belongs to a member of
 * staff, a contact or a worker. The single strongest ghost-vendor indicator
 * there is: the money is going to a person the organisation already pays.
 */
export function vendorPersonCollisions(
  vendors: VendorLike[],
  people: PersonLike[],
): SignalDraft[] {
  const fields: Array<{
    key: "address" | "email" | "phone";
    label: string;
    severity: SignalSeverity;
    confidence: number;
  }> = [
    { key: "address", label: "address", severity: "high", confidence: 0.75 },
    { key: "email", label: "email address", severity: "critical", confidence: 0.9 },
    { key: "phone", label: "phone number", severity: "high", confidence: 0.7 },
  ];
  const drafts: SignalDraft[] = [];
  for (const field of fields) {
    const index = new Map<string, PersonLike[]>();
    for (const p of people) {
      const v = normaliseIdentifier(p[field.key]);
      if (!v) continue;
      const list = index.get(v) ?? [];
      list.push(p);
      index.set(v, list);
    }
    if (index.size === 0) continue;
    for (const vendor of vendors) {
      const v = normaliseIdentifier(vendor[field.key]);
      if (!v) continue;
      const matches = index.get(v);
      if (!matches || matches.length === 0) continue;
      drafts.push({
        detector: "vendor_person_identity_collision",
        severity: field.severity,
        confidence: field.confidence,
        title: `Vendor "${vendor.name}" shares a ${field.label} with ${matches.length === 1 ? matches[0]!.name : `${matches.length} people`} on the register`,
        explanation:
          `Supplier "${vendor.name}" (${vendor.id}) records the ${field.label} "${vendor[field.key]}", ` +
          `which normalises to the same value as ${matches
            .map((m) => `${m.kind} "${m.name}" (${m.id})`)
            .join(", ")}. ` +
          "A supplier that shares contact details with someone the organisation already pays is " +
          "the textbook ghost-vendor pattern (Domain A #53-54). Confirm the supplier exists " +
          "independently — company register, site visit, an invoice from before the relationship.",
        evidenceRefs: {
          vendorId: vendor.id,
          field: field.key,
          value: vendor[field.key],
          normalised: v,
          people: matches.map((m) => ({ id: m.id, kind: m.kind, name: m.name })),
        },
        fingerprint: fingerprintOf(vendor.id, field.key, sortedIds(matches.map((m) => m.id))),
        subjectType: "vendor",
        subjectId: vendor.id,
        links: [
          { objectType: "vendor", objectId: vendor.id, role: "subject" },
          ...matches.map((m) => ({ objectType: m.kind, objectId: m.id })),
        ],
      });
    }
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* #55 sequential supplier invoice numbers                             */
/* ------------------------------------------------------------------ */

/**
 * A real supplier bills many customers, so the invoice numbers WE receive
 * have gaps. A run of consecutive numbers means either we are their only
 * customer, or the numbers are being made up as needed.
 */
export function sequentialInvoiceNumbers(
  invoices: InvoiceLike[],
  vendorNames: Map<string, string>,
  thresholds: GhostVendorThresholds = GHOST_VENDOR_DEFAULTS,
): SignalDraft[] {
  const drafts: SignalDraft[] = [];
  for (const [vendorId, rows] of byVendor(invoices)) {
    const parsed = rows
      .map((r) => ({ row: r, parts: invoiceNumberParts(r.invoiceNumber) }))
      .filter((x): x is { row: InvoiceLike; parts: { prefix: string; n: number } } =>
        x.parts !== null,
      );
    const byPrefix = new Map<string, typeof parsed>();
    for (const p of parsed) {
      const list = byPrefix.get(p.parts.prefix) ?? [];
      list.push(p);
      byPrefix.set(p.parts.prefix, list);
    }
    for (const [prefix, group] of byPrefix) {
      const sorted = [...group].sort((a, b) => a.parts.n - b.parts.n);
      let run: typeof sorted = [];
      const runs: (typeof sorted)[] = [];
      for (const item of sorted) {
        const last = run[run.length - 1];
        if (last && item.parts.n === last.parts.n + 1) run.push(item);
        else {
          if (run.length >= thresholds.sequentialRun) runs.push(run);
          run = [item];
        }
      }
      if (run.length >= thresholds.sequentialRun) runs.push(run);
      for (const found of runs) {
        const ids = found.map((f) => f.row.id);
        const numbers = found.map((f) => f.row.invoiceNumber ?? "").join(", ");
        drafts.push({
          detector: "sequential_invoice_numbers",
          severity: found.length >= thresholds.sequentialRun + 2 ? "high" : "medium",
          confidence: Math.min(0.9, 0.4 + found.length * 0.08),
          title: `Consecutive invoice numbers from ${vendorNames.get(vendorId) ?? vendorId}`,
          explanation:
            `${found.length} invoices received from this supplier carry consecutive numbers ` +
            `(${numbers})${prefix ? ` under the prefix "${prefix}"` : ""}. A supplier with other ` +
            "customers produces gaps in the numbers we see; an unbroken run means we are their " +
            "only customer, or the numbers are being generated to order (Domain A #55).",
          evidenceRefs: {
            vendorId,
            prefix,
            invoiceIds: ids,
            numbers: found.map((f) => f.parts.n),
            runLength: found.length,
          },
          fingerprint: fingerprintOf(vendorId, prefix, sortedIds(ids)),
          subjectType: "vendor",
          subjectId: vendorId,
          links: [
            { objectType: "vendor", objectId: vendorId, role: "subject" },
            ...ids.map((id) => ({ objectType: "invoice", objectId: id })),
          ],
        });
      }
    }
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* #56 split invoicing under an approval threshold                     */
/* ------------------------------------------------------------------ */

/**
 * Work worth more than someone's approval limit, invoiced as several pieces
 * that each sit just under it. Needs a threshold to be meaningful: without
 * one there is no line to be just under, so the detector reports itself
 * skipped rather than guessing.
 */
export function splitInvoicing(
  invoices: InvoiceLike[],
  thresholds: GhostVendorThresholds = GHOST_VENDOR_DEFAULTS,
): { drafts: SignalDraft[]; skippedReason: string | null } {
  const limit = thresholds.approvalThreshold;
  if (!limit || limit <= 0) {
    return {
      drafts: [],
      skippedReason:
        "no approval threshold configured for this company — set one on the detector policy " +
        "(or record delegation-of-authority limits) and the split-invoicing test becomes meaningful",
    };
  }
  const lower = limit * thresholds.splitBand;
  const drafts: SignalDraft[] = [];
  for (const [vendorId, rows] of byVendor(invoices)) {
    const byCurrency = new Map<string, InvoiceLike[]>();
    for (const r of rows) {
      const t = ms(r.billingDate ?? r.createdAt);
      if (t === null) continue;
      if (!(r.total >= lower && r.total < limit)) continue;
      const list = byCurrency.get(r.currency) ?? [];
      list.push(r);
      byCurrency.set(r.currency, list);
    }
    for (const [currency, candidates] of byCurrency) {
      if (candidates.length < 2) continue;
      const sorted = [...candidates].sort(
        (a, b) => (ms(a.billingDate ?? a.createdAt) ?? 0) - (ms(b.billingDate ?? b.createdAt) ?? 0),
      );
      // Sliding 30-day window; report the largest cluster in each window run.
      let start = 0;
      for (let end = 0; end < sorted.length; end++) {
        const endT = ms(sorted[end]!.billingDate ?? sorted[end]!.createdAt)!;
        while (start < end) {
          const startT = ms(sorted[start]!.billingDate ?? sorted[start]!.createdAt)!;
          if (endT - startT <= 30 * DAY_MS) break;
          start += 1;
        }
        const window = sorted.slice(start, end + 1);
        if (window.length < 2) continue;
        const sum = window.reduce((a, r) => a + r.total, 0);
        if (sum <= limit) continue;
        if (end !== sorted.length - 1) {
          // only report at the end of a run, so one cluster fires once
          const nextT = ms(sorted[end + 1]!.billingDate ?? sorted[end + 1]!.createdAt)!;
          const startT = ms(sorted[start]!.billingDate ?? sorted[start]!.createdAt)!;
          if (nextT - startT <= 30 * DAY_MS) continue;
        }
        const ids = window.map((r) => r.id);
        drafts.push({
          detector: "split_invoicing",
          severity: "high",
          confidence: 0.7,
          title: `Invoices split just under the ${money(limit, currency)} approval threshold`,
          explanation:
            `${window.length} invoices from this supplier within 30 days each fall between ` +
            `${money(lower, currency)} and the ${money(limit, currency)} approval threshold ` +
            `(${window.map((r) => money(r.total, currency)).join(", ")}), totalling ` +
            `${money(sum, currency)} — above the threshold that a single invoice would have ` +
            "had to clear. Splitting work to stay under an approval limit defeats the control " +
            "the limit exists to impose (Domain A #56).",
          evidenceRefs: {
            vendorId,
            currency,
            threshold: limit,
            band: [lower, limit],
            invoiceIds: ids,
            amounts: window.map((r) => r.total),
            total: sum,
          },
          fingerprint: fingerprintOf(vendorId, currency, sortedIds(ids)),
          subjectType: "vendor",
          subjectId: vendorId,
          links: [
            { objectType: "vendor", objectId: vendorId, role: "subject" },
            ...ids.map((id) => ({ objectType: "invoice", objectId: id })),
          ],
        });
      }
    }
  }
  return { drafts, skippedReason: null };
}

/* ------------------------------------------------------------------ */
/* #57 invoice dated before the order that authorised it               */
/* ------------------------------------------------------------------ */

export function invoiceBeforePurchaseOrder(
  invoices: InvoiceLike[],
  commitments: CommitmentLike[],
): SignalDraft[] {
  const byId = new Map(commitments.map((c) => [c.id, c]));
  const drafts: SignalDraft[] = [];
  for (const inv of invoices) {
    if (!inv.commitmentId) continue;
    const c = byId.get(inv.commitmentId);
    if (!c) continue;
    const orderIso = c.executionDate ?? c.contractDate;
    const orderT = ms(orderIso);
    const billT = ms(inv.billingDate);
    if (orderT === null || billT === null) continue;
    if (billT >= orderT) continue;
    const days = Math.round((orderT - billT) / DAY_MS);
    drafts.push({
      detector: "invoice_before_purchase_order",
      severity: days >= 30 ? "high" : "medium",
      confidence: 0.8,
      title: `Invoice ${inv.reference} is dated ${days} day${days === 1 ? "" : "s"} before its order`,
      explanation:
        `Invoice ${inv.reference} (${inv.id}) is dated ${inv.billingDate} against commitment ` +
        `${c.reference} (${c.id}), which was not placed until ${orderIso}. Either the work was ` +
        "done before it was authorised and the order was written afterwards to cover it, or the " +
        "invoice date is wrong. Both matter: retrospective authorisation is how unapproved spend " +
        "is regularised (Domain A #57).",
      evidenceRefs: {
        invoiceId: inv.id,
        commitmentId: c.id,
        invoiceDate: inv.billingDate,
        orderDate: orderIso,
        daysBefore: days,
      },
      fingerprint: fingerprintOf(inv.id, c.id),
      subjectType: "invoice",
      subjectId: inv.id,
      links: [
        { objectType: "invoice", objectId: inv.id, role: "subject" },
        { objectType: "commitment", objectId: c.id },
      ],
    });
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* #59 payment to a dormant supplier                                   */
/* ------------------------------------------------------------------ */

export function dormantVendorActivity(
  invoices: InvoiceLike[],
  vendorNames: Map<string, string>,
  thresholds: GhostVendorThresholds = GHOST_VENDOR_DEFAULTS,
): SignalDraft[] {
  const drafts: SignalDraft[] = [];
  for (const [vendorId, rows] of byVendor(invoices)) {
    const dated = rows
      .map((r) => ({ row: r, t: ms(r.billingDate ?? r.createdAt) }))
      .filter((x): x is { row: InvoiceLike; t: number } => x.t !== null)
      .sort((a, b) => a.t - b.t);
    if (dated.length < 2) continue;
    for (let i = 1; i < dated.length; i++) {
      const gapDays = Math.round((dated[i]!.t - dated[i - 1]!.t) / DAY_MS);
      if (gapDays < thresholds.dormantDays) continue;
      const inv = dated[i]!.row;
      drafts.push({
        detector: "dormant_vendor_reactivated",
        severity: "medium",
        confidence: 0.6,
        title: `Dormant supplier ${vendorNames.get(vendorId) ?? vendorId} billed again after ${gapDays} days`,
        explanation:
          `This supplier's previous invoice was ${dated[i - 1]!.row.reference} dated ` +
          `${dated[i - 1]!.row.billingDate ?? "unknown"}; the next is ${inv.reference} dated ` +
          `${inv.billingDate ?? "unknown"}, ${gapDays} days later (${money(inv.total, inv.currency)}). ` +
          "A supplier account left dormant and then reactivated is a standard route for paying a " +
          "shell without creating a new vendor record that would be reviewed (Domain A #59). " +
          "Confirm the supplier is still trading and that the reactivation was requested by an " +
          "operational owner, not by finance.",
        evidenceRefs: {
          vendorId,
          gapDays,
          previousInvoiceId: dated[i - 1]!.row.id,
          invoiceId: inv.id,
          amount: inv.total,
          currency: inv.currency,
        },
        fingerprint: fingerprintOf(vendorId, dated[i - 1]!.row.id, inv.id),
        subjectType: "vendor",
        subjectId: vendorId,
        links: [
          { objectType: "vendor", objectId: vendorId, role: "subject" },
          { objectType: "invoice", objectId: inv.id },
        ],
      });
    }
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* #60 duplicate payments                                              */
/* ------------------------------------------------------------------ */

export function duplicatePayments(
  invoices: InvoiceLike[],
  thresholds: GhostVendorThresholds = GHOST_VENDOR_DEFAULTS,
): SignalDraft[] {
  const drafts: SignalDraft[] = [];
  for (const [vendorId, rows] of byVendor(invoices)) {
    const groups = new Map<string, InvoiceLike[]>();
    for (const r of rows) {
      if (!(r.total > 0)) continue;
      const key = `${r.currency}|${r.total.toFixed(2)}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const sorted = [...group].sort(
        (a, b) => (ms(a.billingDate ?? a.createdAt) ?? 0) - (ms(b.billingDate ?? b.createdAt) ?? 0),
      );
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1]!;
        const b = sorted[i]!;
        const at = ms(a.billingDate ?? a.createdAt);
        const bt = ms(b.billingDate ?? b.createdAt);
        if (at === null || bt === null) continue;
        const days = Math.round((bt - at) / DAY_MS);
        if (days > thresholds.duplicateWindowDays) continue;
        const sameNumber =
          a.invoiceNumber && b.invoiceNumber && a.invoiceNumber.trim() === b.invoiceNumber.trim();
        drafts.push({
          detector: "duplicate_payment",
          severity: sameNumber ? "high" : "medium",
          confidence: sameNumber ? 0.9 : 0.65,
          title: `Possible duplicate payment of ${money(b.total, b.currency)}`,
          explanation:
            `Invoices ${a.reference} (${a.billingDate ?? "undated"}) and ${b.reference} ` +
            `(${b.billingDate ?? "undated"}) from the same supplier are for the identical amount ` +
            `${money(b.total, b.currency)}, ${days} day${days === 1 ? "" : "s"} apart` +
            (sameNumber ? ` and carry the same supplier invoice number "${a.invoiceNumber}"` : "") +
            ". Duplicate settlement of one liability is the most common payables loss there is " +
            "(Domain A #60); check the supporting delivery or valuation for each before paying.",
          evidenceRefs: {
            vendorId,
            key,
            invoiceIds: [a.id, b.id],
            amount: b.total,
            currency: b.currency,
            daysApart: days,
            sameSupplierNumber: Boolean(sameNumber),
          },
          fingerprint: fingerprintOf(vendorId, sortedIds([a.id, b.id])),
          subjectType: "vendor",
          subjectId: vendorId,
          links: [
            { objectType: "invoice", objectId: a.id, role: "subject" },
            { objectType: "invoice", objectId: b.id, role: "subject" },
          ],
        });
      }
    }
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* #58 round-sum invoicing per supplier                                */
/* ------------------------------------------------------------------ */

export function roundSumInvoicing(
  invoices: InvoiceLike[],
  vendorNames: Map<string, string>,
  thresholds: GhostVendorThresholds = GHOST_VENDOR_DEFAULTS,
): SignalDraft[] {
  const drafts: SignalDraft[] = [];
  for (const [vendorId, rows] of byVendor(invoices)) {
    const usable = rows.filter((r) => r.total > 0);
    if (usable.length < 5) continue;
    const round = usable.filter((r) => r.total % 1000 === 0);
    const share = round.length / usable.length;
    if (share < thresholds.roundShare) continue;
    drafts.push({
      detector: "round_sum_invoicing",
      severity: "medium",
      confidence: Math.min(0.85, share),
      title: `${(share * 100).toFixed(0)}% of invoices from ${vendorNames.get(vendorId) ?? vendorId} are round thousands`,
      explanation:
        `${round.length} of ${usable.length} invoices from this supplier are exact multiples of ` +
        "1,000. Measured work priced against a schedule of rates almost never lands on a round " +
        "thousand; an invoice population that does is being written to a number rather than " +
        "computed from quantities (Domain A #58).",
      evidenceRefs: {
        vendorId,
        share,
        roundCount: round.length,
        n: usable.length,
        invoiceIds: round.map((r) => r.id),
      },
      fingerprint: fingerprintOf(vendorId, "n", usable.length, "round", round.length),
      subjectType: "vendor",
      subjectId: vendorId,
      links: [{ objectType: "vendor", objectId: vendorId, role: "subject" }],
    });
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* #61 vendor concentration                                            */
/* ------------------------------------------------------------------ */

/** Never sums across currencies — one bucket per currency, one finding each. */
export function vendorConcentration(
  invoices: InvoiceLike[],
  vendorNames: Map<string, string>,
  thresholds: GhostVendorThresholds = GHOST_VENDOR_DEFAULTS,
): SignalDraft[] {
  const buckets = new Map<string, Map<string, number>>();
  for (const inv of invoices) {
    if (!inv.vendorId || !(inv.total > 0)) continue;
    const perCurrency = buckets.get(inv.currency) ?? new Map<string, number>();
    perCurrency.set(inv.vendorId, (perCurrency.get(inv.vendorId) ?? 0) + inv.total);
    buckets.set(inv.currency, perCurrency);
  }
  const drafts: SignalDraft[] = [];
  for (const [currency, perCurrency] of buckets) {
    if (perCurrency.size < 3) continue; // concentration is meaningless with 2 suppliers
    const total = [...perCurrency.values()].reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    for (const [vendorId, amount] of perCurrency) {
      const share = amount / total;
      if (share < thresholds.concentrationShare) continue;
      drafts.push({
        detector: "vendor_concentration",
        severity: share >= 0.75 ? "high" : "medium",
        confidence: 0.6,
        title: `${vendorNames.get(vendorId) ?? vendorId} holds ${(share * 100).toFixed(0)}% of ${currency} spend`,
        explanation:
          `${money(amount, currency)} of ${money(total, currency)} invoiced across ` +
          `${perCurrency.size} suppliers went to this one supplier (${(share * 100).toFixed(1)}%). ` +
          "Concentration is not itself wrongdoing, but it removes the price comparison that makes " +
          "over-charging visible and it is the state a captured supplier relationship converges " +
          "on (Domain A #61). Totals are per currency and are never summed across them.",
        evidenceRefs: {
          vendorId,
          currency,
          amount,
          total,
          share,
          vendorCount: perCurrency.size,
        },
        fingerprint: fingerprintOf(
          vendorId,
          currency,
          "share",
          Math.round(share * 20) / 20,
          "n",
          perCurrency.size,
        ),
        subjectType: "vendor",
        subjectId: vendorId,
        links: [{ objectType: "vendor", objectId: vendorId, role: "subject" }],
      });
    }
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* #34-36 out-of-hours approvals                                       */
/* ------------------------------------------------------------------ */

export interface ApprovalLike {
  id: string;
  approverId: string;
  decidedAt: string;
  objectType: string;
  objectId: string;
  amount: number | null;
  currency: string | null;
  vendorId: string | null;
}

/** Local hour + weekday for an instant, given a fixed offset in minutes. */
export function localParts(iso: string, tzOffsetMinutes: number): { hour: number; day: number } | null {
  const t = ms(iso);
  if (t === null) return null;
  const shifted = new Date(t + tzOffsetMinutes * 60_000);
  return { hour: shifted.getUTCHours(), day: shifted.getUTCDay() };
}

export function outOfHoursApprovals(
  approvals: ApprovalLike[],
  thresholds: GhostVendorThresholds = GHOST_VENDOR_DEFAULTS,
): SignalDraft[] {
  const [startHour, endHour] = thresholds.workingHours;
  const byApprover = new Map<string, ApprovalLike[]>();
  for (const a of approvals) {
    const parts = localParts(a.decidedAt, thresholds.tzOffsetMinutes);
    if (!parts) continue;
    const weekend = parts.day === 0 || parts.day === 6;
    const outside = parts.hour < startHour || parts.hour >= endHour;
    if (!weekend && !outside) continue;
    const list = byApprover.get(a.approverId) ?? [];
    list.push(a);
    byApprover.set(a.approverId, list);
  }
  const drafts: SignalDraft[] = [];
  for (const [approverId, list] of byApprover) {
    if (list.length < thresholds.outOfHoursCount) continue;
    const ids = list.map((a) => a.id);
    drafts.push({
      detector: "out_of_hours_approval",
      severity: "medium",
      confidence: 0.55,
      title: `${list.length} approvals by ${approverId} outside working hours`,
      explanation:
        `${list.length} approvals were decided outside ${startHour}:00–${endHour}:00 local time ` +
        `or at a weekend (offset ${thresholds.tzOffsetMinutes} minutes from UTC). ` +
        "Approving outside the hours when the people who could question a decision are present " +
        "is a control-avoidance pattern (Domain A #34). It is weak on its own — read it with " +
        "the velocity and affinity findings for the same approver.",
      evidenceRefs: {
        approverId,
        approvalIds: ids,
        workingHours: thresholds.workingHours,
        tzOffsetMinutes: thresholds.tzOffsetMinutes,
        decidedAt: list.map((a) => a.decidedAt),
      },
      fingerprint: fingerprintOf(approverId, sortedIds(ids)),
      subjectType: "user",
      subjectId: approverId,
      links: list.map((a) => ({ objectType: a.objectType, objectId: a.objectId })),
    });
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* #38 approver ↔ vendor affinity                                      */
/* ------------------------------------------------------------------ */

/**
 * One approver signing off nearly everything for one supplier, when they are
 * NOT the approver for most other spend. The comparison against the
 * approver's overall share is what stops this firing on a small team where
 * one person approves everything.
 */
export function approverVendorAffinity(
  approvals: ApprovalLike[],
  vendorNames: Map<string, string>,
  thresholds: GhostVendorThresholds = GHOST_VENDOR_DEFAULTS,
): SignalDraft[] {
  const withVendor = approvals.filter((a) => a.vendorId);
  if (withVendor.length < 8) return [];
  const totalByApprover = new Map<string, number>();
  for (const a of withVendor) {
    totalByApprover.set(a.approverId, (totalByApprover.get(a.approverId) ?? 0) + 1);
  }
  const perVendor = new Map<string, ApprovalLike[]>();
  for (const a of withVendor) {
    const list = perVendor.get(a.vendorId!) ?? [];
    list.push(a);
    perVendor.set(a.vendorId!, list);
  }
  const drafts: SignalDraft[] = [];
  for (const [vendorId, list] of perVendor) {
    if (list.length < 5) continue;
    const counts = new Map<string, number>();
    for (const a of list) counts.set(a.approverId, (counts.get(a.approverId) ?? 0) + 1);
    for (const [approverId, n] of counts) {
      const vendorShare = n / list.length;
      const overallShare = (totalByApprover.get(approverId) ?? 0) / withVendor.length;
      if (vendorShare < thresholds.affinityShare) continue;
      // If they approve everything anyway, this says nothing.
      if (overallShare >= thresholds.affinityShare - 0.2) continue;
      drafts.push({
        detector: "approver_vendor_affinity",
        severity: "high",
        confidence: Math.min(0.85, 0.5 + (vendorShare - overallShare)),
        title: `${approverId} approves ${(vendorShare * 100).toFixed(0)}% of spend for ${vendorNames.get(vendorId) ?? vendorId}`,
        explanation:
          `This approver decided ${n} of ${list.length} approvals for this supplier ` +
          `(${(vendorShare * 100).toFixed(1)}%) while handling only ` +
          `${(overallShare * 100).toFixed(1)}% of approvals overall. An approver who is the ` +
          "gatekeeper for one supplier and few others is either the relationship owner — which " +
          "should be declared — or the reason the supplier keeps being paid (Domain A #38). " +
          "Check the conflict-of-interest register for a declaration covering this pair.",
        evidenceRefs: {
          approverId,
          vendorId,
          vendorApprovals: n,
          vendorTotal: list.length,
          vendorShare,
          overallShare,
          approvalIds: list.filter((a) => a.approverId === approverId).map((a) => a.id),
        },
        fingerprint: fingerprintOf(approverId, vendorId, "n", list.length, "k", n),
        subjectType: "user",
        subjectId: approverId,
        links: [
          { objectType: "vendor", objectId: vendorId, role: "subject" },
          ...list
            .filter((a) => a.approverId === approverId)
            .map((a) => ({ objectType: a.objectType, objectId: a.objectId })),
        ],
      });
    }
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* #41 delegation-of-authority breach                                  */
/* ------------------------------------------------------------------ */

export function authorityLimitBreaches(
  approvals: ApprovalLike[],
  limits: AuthorityLimitLike[],
): SignalDraft[] {
  const byUser = new Map<string, AuthorityLimitLike[]>();
  for (const l of limits) {
    const list = byUser.get(l.userId) ?? [];
    list.push(l);
    byUser.set(l.userId, list);
  }
  const drafts: SignalDraft[] = [];
  for (const a of approvals) {
    if (a.amount === null || !Number.isFinite(a.amount) || !a.currency) continue;
    const applicable = (byUser.get(a.approverId) ?? []).filter(
      (l) =>
        l.currency === a.currency && (l.objectType === "any" || l.objectType === a.objectType),
    );
    if (applicable.length === 0) continue;
    // The most specific limit wins; ties go to the lowest, which is the safe
    // reading of two limits that both apply.
    const limit = applicable
      .sort((x, y) => {
        const spec = (l: AuthorityLimitLike) => (l.objectType === "any" ? 0 : 1);
        return spec(y) - spec(x) || x.maxAmount - y.maxAmount;
      })[0]!;
    if (a.amount <= limit.maxAmount) continue;
    drafts.push({
      detector: "authority_limit_breach",
      severity: "high",
      confidence: 0.95,
      title: `Approval of ${money(a.amount, a.currency)} exceeds ${a.approverId}'s ${money(limit.maxAmount, limit.currency)} limit`,
      explanation:
        `${a.approverId} approved ${a.objectType} ${a.objectId} for ` +
        `${money(a.amount, a.currency)} on ${a.decidedAt}. Their recorded delegation of ` +
        `authority for ${limit.objectType === "any" ? "any object" : limit.objectType} is ` +
        `${money(limit.maxAmount, limit.currency)}. Either the limit is out of date or the ` +
        "approval was outside the authority granted (Domain A #41); an approval above the " +
        "delegated limit is void as a matter of governance whatever its commercial merits.",
      evidenceRefs: {
        approverId: a.approverId,
        approvalId: a.id,
        objectType: a.objectType,
        objectId: a.objectId,
        amount: a.amount,
        currency: a.currency,
        limit: limit.maxAmount,
      },
      fingerprint: fingerprintOf(a.approverId, a.objectType, a.objectId),
      subjectType: "user",
      subjectId: a.approverId,
      links: [{ objectType: a.objectType, objectId: a.objectId, role: "subject" }],
    });
  }
  return drafts;
}

export const GHOST_VENDOR_DETECTORS = [
  "vendor_person_identity_collision",
  "sequential_invoice_numbers",
  "split_invoicing",
  "invoice_before_purchase_order",
  "dormant_vendor_reactivated",
  "duplicate_payment",
  "round_sum_invoicing",
  "vendor_concentration",
  "out_of_hours_approval",
  "approver_vendor_affinity",
  "authority_limit_breach",
] as const;
export type GhostVendorDetector = (typeof GHOST_VENDOR_DETECTORS)[number];
