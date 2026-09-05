/**
 * WHAT A LESSON'S EVIDENCE POINTS AT — the verifiable half of the knowledge
 * graph (spec #992).
 *
 * A lesson says it came out of dispute D-004. Before this file, nothing could
 * check that D-004 existed, belonged to the same tenant, or was still there
 * next month; the "link" was a string somebody typed. This registry maps the
 * `tool` vocabulary used in `evidenceRefs` and `lesson_applications.appliedTo`
 * onto the tables that actually hold those records, so an edge is only stored
 * once the row has been seen.
 *
 * Deliberately small. A tool the registry does not know still produces an
 * edge — knowledge does not stop being knowledge because the platform cannot
 * resolve the pointer — but the edge is stored `verified: 0` and says so, and
 * it is never mirrored into `record_links`, where an unverifiable id would
 * pollute a structure the rest of the platform trusts.
 *
 * (A near-identical registry exists in the automation module for its own
 * purpose. It is not imported here: these two packages are edited
 * independently and a shared registry would couple their release cycles for
 * the sake of ~60 lines.)
 */
import { and, eq } from "drizzle-orm";
import type { AnyPgTable, PgColumn } from "drizzle-orm/pg-core";
import {
  changeEvents,
  commitments,
  contracts,
  delayEvents,
  disputes,
  forensicClaims,
  gateReviews,
  meetings,
  nonConformanceReports,
  obligations,
  projects,
  punchItems,
  rfis,
  risks,
  safetyIncidents,
  signals,
  submittals,
  variations,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";

export interface TargetEntry {
  /** the canonical record type stored on the edge */
  recordType: string;
  table: AnyPgTable;
  idColumn: PgColumn;
  companyColumn: PgColumn;
  /** null for company-level records (contracts are project-scoped; obligations are not) */
  projectColumn: PgColumn | null;
  /** columns tried, in order, for a human label */
  labelColumns: PgColumn[];
  /** SPA path builder, so a graph node can be clicked through to */
  href: (row: Record<string, unknown>) => string | null;
}

const projectHref =
  (segment: string) =>
  (row: Record<string, unknown>): string | null => {
    const projectId = typeof row["projectId"] === "string" ? row["projectId"] : null;
    const id = typeof row["id"] === "string" ? row["id"] : null;
    if (!projectId || !id) return null;
    return `/projects/${projectId}/${segment}?focus=${id}`;
  };

/**
 * Keyed by every alias the platform uses for the same thing: the TOOL key a
 * user's evidence ref carries ("forensics"), and the record type the ledger
 * uses ("delay_event"). Both resolve to the same entry.
 */
const ENTRIES: Array<{ aliases: string[]; entry: TargetEntry }> = [
  {
    aliases: ["disputes", "dispute"],
    entry: {
      recordType: "dispute",
      table: disputes,
      idColumn: disputes.id,
      companyColumn: disputes.companyId,
      projectColumn: disputes.projectId,
      labelColumns: [disputes.title],
      href: projectHref("disputes"),
    },
  },
  {
    aliases: ["forensics", "delay_event", "delayEvent"],
    entry: {
      recordType: "delay_event",
      table: delayEvents,
      idColumn: delayEvents.id,
      companyColumn: delayEvents.companyId,
      projectColumn: delayEvents.projectId,
      labelColumns: [delayEvents.title],
      href: projectHref("forensics"),
    },
  },
  {
    aliases: ["forensic_claim", "claim"],
    entry: {
      recordType: "forensic_claim",
      table: forensicClaims,
      idColumn: forensicClaims.id,
      companyColumn: forensicClaims.companyId,
      projectColumn: forensicClaims.projectId,
      labelColumns: [forensicClaims.title],
      href: projectHref("forensics"),
    },
  },
  {
    aliases: ["commercial", "variation"],
    entry: {
      recordType: "variation",
      table: variations,
      idColumn: variations.id,
      companyColumn: variations.companyId,
      projectColumn: variations.projectId,
      labelColumns: [variations.title],
      href: projectHref("commercial"),
    },
  },
  {
    aliases: ["assurance", "signal"],
    entry: {
      recordType: "signal",
      table: signals,
      idColumn: signals.id,
      companyColumn: signals.companyId,
      projectColumn: signals.projectId,
      labelColumns: [signals.title],
      href: projectHref("assurance"),
    },
  },
  {
    aliases: ["governance", "gate_review"],
    entry: {
      recordType: "gate_review",
      table: gateReviews,
      idColumn: gateReviews.id,
      companyColumn: gateReviews.companyId,
      projectColumn: gateReviews.projectId,
      labelColumns: [gateReviews.decision],
      href: projectHref("governance"),
    },
  },
  {
    aliases: ["rfis", "rfi"],
    entry: {
      recordType: "rfi",
      table: rfis,
      idColumn: rfis.id,
      companyColumn: rfis.companyId,
      projectColumn: rfis.projectId,
      labelColumns: [rfis.subject],
      href: projectHref("rfis"),
    },
  },
  {
    aliases: ["submittals", "submittal"],
    entry: {
      recordType: "submittal",
      table: submittals,
      idColumn: submittals.id,
      companyColumn: submittals.companyId,
      projectColumn: submittals.projectId,
      labelColumns: [submittals.title],
      href: projectHref("submittals"),
    },
  },
  {
    aliases: ["punch", "punch_item"],
    entry: {
      recordType: "punch_item",
      table: punchItems,
      idColumn: punchItems.id,
      companyColumn: punchItems.companyId,
      projectColumn: punchItems.projectId,
      labelColumns: [punchItems.title],
      href: projectHref("punch"),
    },
  },
  {
    aliases: ["change_management", "change_event"],
    entry: {
      recordType: "change_event",
      table: changeEvents,
      idColumn: changeEvents.id,
      companyColumn: changeEvents.companyId,
      projectColumn: changeEvents.projectId,
      labelColumns: [changeEvents.title],
      href: projectHref("changes"),
    },
  },
  {
    aliases: ["risk", "risks"],
    entry: {
      recordType: "risk",
      table: risks,
      idColumn: risks.id,
      companyColumn: risks.companyId,
      projectColumn: risks.projectId,
      labelColumns: [risks.title],
      href: projectHref("risk"),
    },
  },
  {
    aliases: ["quality", "ncr"],
    entry: {
      recordType: "ncr",
      table: nonConformanceReports,
      idColumn: nonConformanceReports.id,
      companyColumn: nonConformanceReports.companyId,
      projectColumn: nonConformanceReports.projectId,
      labelColumns: [nonConformanceReports.title],
      href: projectHref("quality"),
    },
  },
  {
    aliases: ["safety", "incident", "safety_incident"],
    entry: {
      recordType: "safety_incident",
      table: safetyIncidents,
      idColumn: safetyIncidents.id,
      companyColumn: safetyIncidents.companyId,
      projectColumn: safetyIncidents.projectId,
      labelColumns: [safetyIncidents.title],
      href: projectHref("safety"),
    },
  },
  {
    aliases: ["meetings", "meeting"],
    entry: {
      recordType: "meeting",
      table: meetings,
      idColumn: meetings.id,
      companyColumn: meetings.companyId,
      projectColumn: meetings.projectId,
      labelColumns: [meetings.title],
      href: projectHref("meetings"),
    },
  },
  {
    aliases: ["contracts", "contract"],
    entry: {
      recordType: "contract",
      table: contracts,
      idColumn: contracts.id,
      companyColumn: contracts.companyId,
      projectColumn: contracts.projectId,
      labelColumns: [contracts.name],
      href: projectHref("contracts"),
    },
  },
  {
    aliases: ["commitments", "commitment"],
    entry: {
      recordType: "commitment",
      table: commitments,
      idColumn: commitments.id,
      companyColumn: commitments.companyId,
      projectColumn: commitments.projectId,
      labelColumns: [commitments.title],
      href: projectHref("commitments"),
    },
  },
  {
    aliases: ["obligation", "obligations"],
    entry: {
      recordType: "obligation",
      table: obligations,
      idColumn: obligations.id,
      companyColumn: obligations.companyId,
      projectColumn: obligations.projectId,
      labelColumns: [obligations.title],
      href: projectHref("contracts"),
    },
  },
  {
    aliases: ["projects", "project"],
    entry: {
      recordType: "project",
      table: projects,
      idColumn: projects.id,
      companyColumn: projects.companyId,
      projectColumn: projects.id,
      labelColumns: [projects.name],
      href: (row) =>
        typeof row["id"] === "string" ? `/projects/${row["id"]}/overview` : null,
    },
  },
];

const BY_ALIAS = new Map<string, TargetEntry>();
for (const { aliases, entry } of ENTRIES) {
  for (const alias of aliases) BY_ALIAS.set(alias.toLowerCase(), entry);
}

export function targetEntryFor(tool: string): TargetEntry | null {
  return BY_ALIAS.get(tool.trim().toLowerCase()) ?? null;
}

/** Every record type the graph can verify — published so the UI can say so. */
export function knownTargetTypes(): string[] {
  return [...new Set(ENTRIES.map((e) => e.entry.recordType))].sort();
}

export interface ResolvedTarget {
  recordType: string;
  projectId: string | null;
  label: string | null;
  href: string | null;
}

/**
 * Look the target up in its own table, inside the caller's company. Returns
 * null when the type is unknown OR the row is not there — the caller must
 * treat both as "unverified" and say which.
 */
export async function resolveTarget(
  db: Db,
  companyId: string,
  tool: string,
  recordId: string,
): Promise<ResolvedTarget | null> {
  const entry = targetEntryFor(tool);
  if (!entry) return null;
  const rows = (await db
    .select()
    .from(entry.table)
    .where(and(eq(entry.idColumn, recordId), eq(entry.companyColumn, companyId)))
    .limit(1)) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  let label: string | null = null;
  for (const col of entry.labelColumns) {
    const name = col.name;
    /* drizzle returns rows keyed by the TS property name, not the column
       name; try both so a registry entry never silently yields no label. */
    const camel = name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const value = row[camel] ?? row[name];
    if (typeof value === "string" && value.trim()) {
      label = value.trim();
      break;
    }
  }
  const projectId =
    entry.projectColumn === null
      ? null
      : typeof row["projectId"] === "string"
        ? (row["projectId"] as string)
        : typeof row["id"] === "string" && entry.recordType === "project"
          ? (row["id"] as string)
          : null;
  return { recordType: entry.recordType, projectId, label, href: entry.href(row) };
}
