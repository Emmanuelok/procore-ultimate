/**
 * The eight assurance-layer data primitives (master specification, Volume III §4).
 *
 * Everything in the assurance layer reduces to: an Assertion made by a party,
 * Evidence bearing on it, and a Reconciliation joining the two. Obligations,
 * Events, Entities and Signals give the reconciliation contractual and
 * investigative meaning, and every state change lands in the append-only
 * hash-chained Ledger.
 *
 * Design rule (spec §4): an Assertion and the Evidence used to test it must
 * never be created by the same actor through the same pathway. The API layer
 * enforces this; these types carry the fields that make it checkable.
 */

import type {
  AssertionKind,
  EvidenceKind,
  ReconciliationResult,
  ObligationStatus,
  SignalSeverity,
  SignalDisposition,
  EntityKind,
  EntityRelationshipKind,
  LedgerAction,
} from "./enums.js";

export interface AssertionRecord {
  id: string;
  companyId: string;
  projectId: string;
  kind: AssertionKind;
  /** party making the claim (Entity id or user id) */
  claimantId: string;
  claimantKind: "user" | "entity";
  value: number | null;
  unit: string | null;
  /** free-text basis, e.g. "BQ item 3.2.1 remeasure" */
  basis: string;
  contractRef: string | null;
  /** source record on the operational side, e.g. an invoice line or daily log */
  sourceType: string | null;
  sourceId: string | null;
  assertedAt: string;
  createdAt: string;
}

export interface EvidenceRecord {
  id: string;
  companyId: string;
  projectId: string;
  kind: EvidenceKind;
  source: string;
  /** sha256 of the payload, computed at ingest — the anchor of admissibility */
  contentHash: string;
  fileId: string | null;
  capturedAt: string | null;
  ingestedAt: string;
  /** 0..1: how independent the source is from the claimant population */
  independenceScore: number;
  provenance: unknown;
  metadata: unknown;
}

export interface ReconciliationRecord {
  id: string;
  companyId: string;
  projectId: string;
  assertionId: string;
  evidenceIds: string[];
  method: string;
  result: ReconciliationResult;
  variance: number | null;
  variancePercent: number | null;
  confidence: number | null;
  reviewerId: string | null;
  disposition: string | null;
  notes: string | null;
  createdAt: string;
}

export interface ObligationRecord {
  id: string;
  companyId: string;
  projectId: string;
  sourceClause: string;
  obligorId: string | null;
  obligeeId: string | null;
  trigger: string;
  deadline: string | null;
  evidenceRequirement: string | null;
  status: ObligationStatus;
  createdAt: string;
}

export interface EventRecord {
  id: string;
  companyId: string;
  projectId: string;
  type: string;
  occurredAt: string;
  location: string | null;
  detectedOrReported: "detected" | "reported";
  causalLinks: string[];
  payload: unknown;
  createdAt: string;
}

export interface EntityRecord {
  id: string;
  companyId: string;
  kind: EntityKind;
  name: string;
  identifiers: Record<string, string>;
  jurisdiction: string | null;
  screeningStatus: string | null;
  createdAt: string;
}

export interface EntityRelationshipRecord {
  id: string;
  companyId: string;
  fromEntityId: string;
  toEntityId: string;
  kind: EntityRelationshipKind;
  since: string | null;
  source: string | null;
  confidence: number | null;
}

export interface SignalRecord {
  id: string;
  companyId: string;
  projectId: string | null;
  detector: string;
  severity: SignalSeverity;
  confidence: number;
  title: string;
  explanation: string;
  evidenceRefs: unknown;
  disposition: SignalDisposition;
  reviewerId: string | null;
  reviewerNotes: string | null;
  createdAt: string;
}

export interface LedgerEntryRecord {
  seq: number;
  companyId: string;
  actorId: string | null;
  action: LedgerAction;
  objectType: string;
  objectId: string;
  /** canonical JSON snapshot (or diff) of the state being recorded */
  payloadHash: string;
  prevHash: string;
  entryHash: string;
  at: string;
}
