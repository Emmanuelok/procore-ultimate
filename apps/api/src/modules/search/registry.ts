/**
 * The search source registry (cross-package contract §3.3).
 *
 * A source is one record type that company-wide search knows how to look in:
 * which table, which columns are text, which tool gates it, and how to build
 * the SPA link for a hit. `registerSearchSource` lets a module that this
 * package cannot edit add itself:
 *
 *     import { registerSearchSource, tableSource } from "../search/registry.js";
 *     registerSearchSource(tableSource({ type: "correspondence", … }));
 *
 * Registration is idempotent by `type` — re-registering replaces, so a module
 * registered from inside a Fastify plugin (which runs once per built app, and
 * a test file builds several) never duplicates a source.
 *
 * The built-in sources below cover every type named in the contract that has
 * a table in @constructos/db today. Types belonging to modules that land in
 * this same wave (correspondence and friends) register themselves.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  bidPackages,
  changeEvents,
  commitments,
  companyMemberships,
  contacts,
  contracts,
  dailyLogs,
  drawingSheets,
  equipment,
  files,
  invoices,
  lessons,
  meetings,
  nonConformanceReports,
  obligations,
  projects,
  punchItems,
  rfis,
  risks,
  safetyIncidents,
  signals,
  specSections,
  submittals,
  users,
  vendors,
  workers,
} from "@constructos/db";
import type { ToolKey } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { likePattern } from "./engine.js";

/** One candidate row, before scoring. */
export interface SearchCandidate {
  id: string;
  projectId: string | null;
  title: string;
  subtitle: string | null;
  reference: string | null;
  status: string | null;
  updatedAt: string | null;
}

export interface SearchQueryContext {
  companyId: string;
  terms: string[];
  /** null = every project in the tenant; [] = none */
  projectIds: string[] | null;
  /** narrow to one project when the caller asked for it */
  projectId?: string | null;
  limit: number;
}

export interface SearchSource {
  /** the `type` on every hit — must be stable, it is a client-facing key */
  type: string;
  label: string;
  /**
   * The tool a caller needs `read` on for hits of this type. `null` means the
   * record is company-level (directory, users) and company membership is
   * enough.
   */
  tool: ToolKey | null;
  /** project-scoped records are filtered by the caller's visible projects */
  scope: "project" | "company";
  /** relative importance, applied to the score (1 = neutral) */
  weight?: number;
  /** SPA path for a hit */
  href: (row: SearchCandidate) => string;
  query: (db: Db, ctx: SearchQueryContext) => Promise<SearchCandidate[]>;
}

const sources = new Map<string, SearchSource>();

/** Register (or replace) a source. Returns an unregister function. */
export function registerSearchSource(source: SearchSource): () => void {
  sources.set(source.type, source);
  return () => {
    if (sources.get(source.type) === source) sources.delete(source.type);
  };
}

export function listSearchSources(): SearchSource[] {
  return [...sources.values()].sort((a, b) => a.type.localeCompare(b.type));
}

export function getSearchSource(type: string): SearchSource | undefined {
  return sources.get(type);
}

/* ------------------------------------------------------------------ */
/* tableSource — the shape almost every source wants                   */
/* ------------------------------------------------------------------ */

export interface TableSourceSpec {
  type: string;
  label: string;
  tool: ToolKey | null;
  scope: "project" | "company";
  weight?: number;
  table: PgTable;
  columns: {
    id: PgColumn;
    companyId: PgColumn;
    projectId?: PgColumn;
    title: PgColumn;
    subtitle?: PgColumn;
    reference?: PgColumn;
    status?: PgColumn;
    updatedAt?: PgColumn;
  };
  /** the text columns the ILIKE candidate fetch looks in */
  searchColumns: PgColumn[];
  /** extra predicate, e.g. `isNull(files.deletedAt)` */
  filter?: SQL | undefined;
  href: (row: SearchCandidate) => string;
}

const NULL_TEXT = sql<string | null>`null`;

export function tableSource(spec: TableSourceSpec): SearchSource {
  return {
    type: spec.type,
    label: spec.label,
    tool: spec.tool,
    scope: spec.scope,
    weight: spec.weight,
    href: spec.href,
    async query(db, ctx) {
      if (ctx.terms.length === 0) return [];
      if (spec.scope === "project" && ctx.projectIds !== null && ctx.projectIds.length === 0) {
        return [];
      }
      const conds: SQL[] = [eq(spec.columns.companyId, ctx.companyId)];
      if (spec.filter) conds.push(spec.filter);

      const projectCol = spec.columns.projectId;
      if (projectCol) {
        if (ctx.projectId) {
          conds.push(eq(projectCol, ctx.projectId));
        } else if (ctx.projectIds !== null) {
          // A nullable project column means "company-level row of a
          // project-scoped type" (a published lesson, an unassigned machine):
          // those stay visible to any member of the tenant.
          const scoped = inArray(projectCol, ctx.projectIds);
          conds.push(
            (projectCol.notNull ? scoped : or(isNull(projectCol), scoped)!) as SQL,
          );
        }
      }

      // AND across terms, OR across columns: every word must appear
      // somewhere, which is what a person typing two words means.
      for (const term of ctx.terms) {
        const pattern = likePattern(term);
        const perColumn = spec.searchColumns.map(
          (col) => sql`${col} ilike ${pattern}`,
        );
        const clause = perColumn.length === 1 ? perColumn[0]! : or(...perColumn)!;
        conds.push(clause as SQL);
      }

      const rows = (await db
        .select({
          id: spec.columns.id,
          projectId: projectCol ?? NULL_TEXT,
          title: spec.columns.title,
          subtitle: spec.columns.subtitle ?? NULL_TEXT,
          reference: spec.columns.reference ?? NULL_TEXT,
          status: spec.columns.status ?? NULL_TEXT,
          updatedAt: spec.columns.updatedAt ?? NULL_TEXT,
        })
        .from(spec.table)
        .where(and(...conds))
        .limit(ctx.limit)) as unknown as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: String(r["id"] ?? ""),
        projectId: r["projectId"] == null ? null : String(r["projectId"]),
        title: r["title"] == null ? "" : String(r["title"]),
        subtitle: r["subtitle"] == null ? null : String(r["subtitle"]),
        reference: r["reference"] == null ? null : String(r["reference"]),
        status: r["status"] == null ? null : String(r["status"]),
        updatedAt: r["updatedAt"] == null ? null : String(r["updatedAt"]),
      }));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Built-in sources                                                    */
/* ------------------------------------------------------------------ */

const projectHref = (projectId: string | null, suffix: string) =>
  projectId ? `/projects/${projectId}${suffix}` : suffix;

/**
 * Registered once at module load. The registry is process-wide and holds only
 * descriptors (no database handle), so several apps in one test process share
 * it safely — every query takes its `db` from the request.
 */
export function registerBuiltinSearchSources(): void {
  registerSearchSource(
    tableSource({
      type: "project",
      label: "Projects",
      tool: "projects",
      scope: "project",
      weight: 1.2,
      table: projects,
      columns: {
        id: projects.id,
        companyId: projects.companyId,
        projectId: projects.id,
        title: projects.name,
        subtitle: projects.city,
        reference: projects.number,
        status: projects.stage,
        updatedAt: projects.updatedAt,
      },
      searchColumns: [projects.name, projects.number, projects.city, projects.address],
      filter: isNull(projects.deletedAt),
      href: (r) => `/projects/${r.id}`,
    }),
  );

  registerSearchSource(
    tableSource({
      type: "rfi",
      label: "RFIs",
      tool: "rfis",
      scope: "project",
      table: rfis,
      columns: {
        id: rfis.id,
        companyId: rfis.companyId,
        projectId: rfis.projectId,
        title: rfis.subject,
        subtitle: rfis.question,
        reference: rfis.number,
        status: rfis.status,
        updatedAt: rfis.updatedAt,
      },
      searchColumns: [rfis.subject, rfis.question],
      href: (r) => projectHref(r.projectId, `/rfis/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "submittal",
      label: "Submittals",
      tool: "submittals",
      scope: "project",
      table: submittals,
      columns: {
        id: submittals.id,
        companyId: submittals.companyId,
        projectId: submittals.projectId,
        title: submittals.title,
        subtitle: submittals.specSection,
        reference: submittals.number,
        status: submittals.status,
        updatedAt: submittals.updatedAt,
      },
      searchColumns: [submittals.title, submittals.specSection],
      href: (r) => projectHref(r.projectId, `/submittals/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "drawing_sheet",
      label: "Drawings",
      tool: "drawings",
      scope: "project",
      table: drawingSheets,
      columns: {
        id: drawingSheets.id,
        companyId: drawingSheets.companyId,
        projectId: drawingSheets.projectId,
        title: drawingSheets.title,
        subtitle: drawingSheets.discipline,
        reference: drawingSheets.number,
        updatedAt: drawingSheets.updatedAt,
      },
      searchColumns: [drawingSheets.title, drawingSheets.number],
      href: (r) => projectHref(r.projectId, `/drawings/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "document",
      label: "Documents",
      tool: "documents",
      scope: "project",
      table: files,
      columns: {
        id: files.id,
        companyId: files.companyId,
        projectId: files.projectId,
        title: files.name,
        subtitle: files.description,
        reference: files.revisionLabel,
        status: files.documentType,
        updatedAt: files.updatedAt,
      },
      searchColumns: [files.name, files.description],
      filter: isNull(files.deletedAt),
      href: (r) => projectHref(r.projectId, `/documents?file=${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "spec_section",
      label: "Specifications",
      tool: "specifications",
      scope: "project",
      table: specSections,
      columns: {
        id: specSections.id,
        companyId: specSections.companyId,
        projectId: specSections.projectId,
        title: specSections.title,
        subtitle: specSections.divisionCode,
        reference: specSections.code,
        status: specSections.status,
        updatedAt: specSections.updatedAt,
      },
      searchColumns: [specSections.title, specSections.code, specSections.normalisedCode],
      href: (r) => projectHref(r.projectId, `/specifications/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "punch",
      label: "Punch list",
      tool: "punch",
      scope: "project",
      table: punchItems,
      columns: {
        id: punchItems.id,
        companyId: punchItems.companyId,
        projectId: punchItems.projectId,
        title: punchItems.title,
        subtitle: punchItems.description,
        reference: punchItems.number,
        status: punchItems.status,
        updatedAt: punchItems.updatedAt,
      },
      searchColumns: [punchItems.title, punchItems.description],
      href: (r) => projectHref(r.projectId, `/punch/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "daily_log",
      label: "Daily logs",
      tool: "daily_logs",
      scope: "project",
      table: dailyLogs,
      columns: {
        id: dailyLogs.id,
        companyId: dailyLogs.companyId,
        projectId: dailyLogs.projectId,
        title: dailyLogs.logDate,
        subtitle: dailyLogs.notes,
        status: dailyLogs.status,
        updatedAt: dailyLogs.updatedAt,
      },
      searchColumns: [dailyLogs.logDate, dailyLogs.notes],
      href: (r) => projectHref(r.projectId, `/daily-logs/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "meeting",
      label: "Meetings",
      tool: "meetings",
      scope: "project",
      table: meetings,
      columns: {
        id: meetings.id,
        companyId: meetings.companyId,
        projectId: meetings.projectId,
        title: meetings.title,
        subtitle: meetings.location,
        reference: meetings.reference,
        status: meetings.status,
        updatedAt: meetings.updatedAt,
      },
      searchColumns: [meetings.title, meetings.reference],
      href: (r) => projectHref(r.projectId, `/meetings/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "commitment",
      label: "Commitments",
      tool: "commitments",
      scope: "project",
      table: commitments,
      columns: {
        id: commitments.id,
        companyId: commitments.companyId,
        projectId: commitments.projectId,
        title: commitments.title,
        subtitle: commitments.description,
        reference: commitments.reference,
        status: commitments.status,
        updatedAt: commitments.updatedAt,
      },
      searchColumns: [commitments.title, commitments.reference, commitments.description],
      href: (r) => projectHref(r.projectId, `/commitments/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "change_event",
      label: "Change events",
      tool: "change_management",
      scope: "project",
      table: changeEvents,
      columns: {
        id: changeEvents.id,
        companyId: changeEvents.companyId,
        projectId: changeEvents.projectId,
        title: changeEvents.title,
        subtitle: changeEvents.description,
        reference: changeEvents.reference,
        status: changeEvents.status,
        updatedAt: changeEvents.updatedAt,
      },
      searchColumns: [changeEvents.title, changeEvents.reference, changeEvents.description],
      href: (r) => projectHref(r.projectId, `/changes/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "invoice",
      label: "Invoices",
      tool: "invoicing",
      scope: "project",
      table: invoices,
      columns: {
        id: invoices.id,
        companyId: invoices.companyId,
        projectId: invoices.projectId,
        title: invoices.reference,
        subtitle: invoices.title,
        reference: invoices.invoiceNumber,
        status: invoices.status,
        updatedAt: invoices.updatedAt,
      },
      searchColumns: [invoices.reference, invoices.title, invoices.invoiceNumber],
      href: (r) => projectHref(r.projectId, `/invoicing/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "contract",
      label: "Contracts",
      tool: "contracts",
      scope: "project",
      table: contracts,
      columns: {
        id: contracts.id,
        companyId: contracts.companyId,
        projectId: contracts.projectId,
        title: contracts.name,
        subtitle: contracts.form,
        status: contracts.status,
        updatedAt: contracts.updatedAt,
      },
      searchColumns: [contracts.name],
      href: (r) => projectHref(r.projectId, `/contracts/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "risk",
      label: "Risks",
      tool: "risk",
      scope: "project",
      table: risks,
      columns: {
        id: risks.id,
        companyId: risks.companyId,
        projectId: risks.projectId,
        title: risks.title,
        subtitle: risks.description,
        reference: risks.number,
        status: risks.status,
        updatedAt: risks.updatedAt,
      },
      searchColumns: [risks.title, risks.description],
      href: (r) => projectHref(r.projectId, `/risk/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "signal",
      label: "Integrity signals",
      tool: "assurance",
      scope: "project",
      table: signals,
      columns: {
        id: signals.id,
        companyId: signals.companyId,
        projectId: signals.projectId,
        title: signals.title,
        subtitle: signals.explanation,
        reference: signals.detector,
        status: signals.disposition,
        updatedAt: signals.lastSeenAt,
      },
      searchColumns: [signals.title, signals.explanation, signals.detector],
      href: (r) => `/assurance/signals/${r.id}`,
    }),
  );

  registerSearchSource(
    tableSource({
      type: "obligation",
      label: "Obligations",
      tool: "contracts",
      scope: "project",
      table: obligations,
      columns: {
        id: obligations.id,
        companyId: obligations.companyId,
        projectId: obligations.projectId,
        title: obligations.sourceClause,
        subtitle: obligations.trigger,
        status: obligations.status,
        updatedAt: obligations.createdAt,
      },
      searchColumns: [obligations.sourceClause, obligations.trigger],
      href: (r) => projectHref(r.projectId, `/contracts?obligation=${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "vendor",
      label: "Vendors",
      tool: "directory",
      scope: "company",
      weight: 1.1,
      table: vendors,
      columns: {
        id: vendors.id,
        companyId: vendors.companyId,
        title: vendors.name,
        subtitle: vendors.city,
        reference: vendors.taxId,
        status: vendors.status,
        updatedAt: vendors.updatedAt,
      },
      searchColumns: [vendors.name, vendors.email, vendors.city, vendors.registrationNumber],
      filter: isNull(vendors.deletedAt),
      href: (r) => `/directory?vendor=${r.id}`,
    }),
  );

  registerSearchSource(
    tableSource({
      type: "contact",
      label: "Contacts",
      tool: "directory",
      scope: "company",
      table: contacts,
      columns: {
        id: contacts.id,
        companyId: contacts.companyId,
        title: contacts.name,
        subtitle: contacts.email,
        reference: contacts.phone,
        updatedAt: contacts.updatedAt,
      },
      searchColumns: [contacts.name, contacts.email],
      filter: isNull(contacts.deletedAt),
      href: (r) => `/directory?contact=${r.id}`,
    }),
  );

  registerSearchSource(
    tableSource({
      type: "lesson",
      label: "Lessons learned",
      tool: "learning",
      scope: "project",
      table: lessons,
      columns: {
        id: lessons.id,
        companyId: lessons.companyId,
        projectId: lessons.projectId,
        title: lessons.title,
        subtitle: lessons.context,
        reference: lessons.number,
        status: lessons.status,
        updatedAt: lessons.updatedAt,
      },
      searchColumns: [lessons.title, lessons.context, lessons.recommendation],
      href: (r) => `/learning/${r.id}`,
    }),
  );

  registerSearchSource(
    tableSource({
      type: "incident",
      label: "Safety incidents",
      tool: "safety",
      scope: "project",
      table: safetyIncidents,
      columns: {
        id: safetyIncidents.id,
        companyId: safetyIncidents.companyId,
        projectId: safetyIncidents.projectId,
        title: safetyIncidents.title,
        subtitle: safetyIncidents.description,
        reference: safetyIncidents.reference,
        status: safetyIncidents.status,
        updatedAt: safetyIncidents.updatedAt,
      },
      searchColumns: [safetyIncidents.title, safetyIncidents.reference],
      href: (r) => projectHref(r.projectId, `/safety/incidents/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "ncr",
      label: "Non-conformance",
      tool: "quality",
      scope: "project",
      table: nonConformanceReports,
      columns: {
        id: nonConformanceReports.id,
        companyId: nonConformanceReports.companyId,
        projectId: nonConformanceReports.projectId,
        title: nonConformanceReports.title,
        subtitle: nonConformanceReports.description,
        reference: nonConformanceReports.reference,
        status: nonConformanceReports.status,
        updatedAt: nonConformanceReports.updatedAt,
      },
      searchColumns: [nonConformanceReports.title, nonConformanceReports.reference],
      href: (r) => projectHref(r.projectId, `/quality/ncr/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "equipment",
      label: "Equipment",
      tool: "equipment",
      scope: "project",
      table: equipment,
      columns: {
        id: equipment.id,
        companyId: equipment.companyId,
        projectId: equipment.projectId,
        title: equipment.name,
        subtitle: equipment.description,
        reference: equipment.reference,
        status: equipment.status,
        updatedAt: equipment.updatedAt,
      },
      searchColumns: [equipment.name, equipment.reference, equipment.assetTag],
      href: (r) => projectHref(r.projectId, `/equipment/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "worker",
      label: "Workforce",
      tool: "workforce",
      scope: "project",
      table: workers,
      columns: {
        id: workers.id,
        companyId: workers.companyId,
        projectId: workers.projectId,
        title: workers.fullName,
        subtitle: workers.trade,
        reference: workers.reference,
        status: workers.status,
        updatedAt: workers.updatedAt,
      },
      searchColumns: [workers.fullName, workers.reference],
      href: (r) => projectHref(r.projectId, `/workforce/${r.id}`),
    }),
  );

  registerSearchSource(
    tableSource({
      type: "bid_package",
      label: "Bid packages",
      tool: "bidding",
      scope: "project",
      table: bidPackages,
      columns: {
        id: bidPackages.id,
        companyId: bidPackages.companyId,
        projectId: bidPackages.projectId,
        title: bidPackages.title,
        subtitle: bidPackages.scopeDescription,
        reference: bidPackages.reference,
        status: bidPackages.status,
        updatedAt: bidPackages.updatedAt,
      },
      searchColumns: [bidPackages.title, bidPackages.reference],
      href: (r) => projectHref(r.projectId, `/bidding/${r.id}`),
    }),
  );

  // People are not a tenant table: the tenant relation lives on
  // company_memberships, so this one is hand-written rather than a
  // tableSource. It is also the only source that must never leak an address
  // to a caller outside the tenant, which the inner join guarantees.
  registerSearchSource({
    type: "user",
    label: "People",
    tool: null,
    scope: "company",
    href: (r) => `/admin?user=${r.id}`,
    async query(db, ctx) {
      if (ctx.terms.length === 0) return [];
      const conds: SQL[] = [eq(companyMemberships.companyId, ctx.companyId)];
      for (const term of ctx.terms) {
        const pattern = likePattern(term);
        conds.push(
          or(sql`${users.name} ilike ${pattern}`, sql`${users.email} ilike ${pattern}`)! as SQL,
        );
      }
      const rows = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: companyMemberships.role,
          isActive: users.isActive,
          updatedAt: users.updatedAt,
        })
        .from(companyMemberships)
        .innerJoin(users, eq(users.id, companyMemberships.userId))
        .where(and(...conds))
        .limit(ctx.limit);
      return rows.map((r) => ({
        id: r.id,
        projectId: null,
        title: r.name,
        subtitle: r.email,
        reference: null,
        status: r.isActive ? r.role : "inactive",
        updatedAt: r.updatedAt,
      }));
    },
  });
}

registerBuiltinSearchSources();
