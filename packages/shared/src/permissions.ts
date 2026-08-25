/**
 * Role-based access control model.
 *
 * Two layers:
 *  1. Company roles — what a user is inside a tenant (owner/admin/member/guest).
 *  2. Project tool permissions — per-tool levels mirroring the
 *     None / ReadOnly / Standard / Admin model, resolved from a role template
 *     with per-user overrides.
 *
 * A separate, deliberately segregated set of assurance roles exists for
 * auditors / independent reviewers / regulators: they are read-only over
 * operational records and are the only roles that may disposition integrity
 * signals. Operational admins must NOT be able to disposition signals about
 * their own records (segregation of duties).
 */

export const COMPANY_ROLES = ["owner", "admin", "member", "guest"] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

export const PERMISSION_LEVELS = ["none", "read", "standard", "admin"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

/** Every permission-scoped tool on the platform. */
export const TOOLS = [
  "directory",
  "projects",
  "documents",
  "drawings",
  "specifications",
  "bim",
  "twin",
  "rfis",
  "submittals",
  "daily_logs",
  "punch",
  "photos",
  "meetings",
  "workflow",
  "budget",
  "commitments",
  "change_management",
  "invoicing",
  "commercial",
  "contracts",
  "schedule",
  "forensics",
  "payments",
  "risk",
  "governance",
  "finance",
  "disputes",
  "land",
  "workforce",
  "esg",
  "jurisdiction",
  "analytics",
  "ingestion",
  "benchmarks",
  "insurance",
  "learning",
  "integrations",
  "assurance",
  "ai",
  "admin",
] as const;
export type ToolKey = (typeof TOOLS)[number];

/** Assurance-layer roles, granted per project, independent of tool levels. */
export const ASSURANCE_ROLES = [
  "integrity_reviewer", // independent reviewer: read-all + signal disposition
  "auditor", // auditor workspace: read-all + evidence pack assembly
  "regulator", // scoped, time-boxed read access
] as const;
export type AssuranceRole = (typeof ASSURANCE_ROLES)[number];

export type ToolPermissionMap = Partial<Record<ToolKey, PermissionLevel>>;

export interface PermissionTemplate {
  key: string;
  name: string;
  description: string;
  tools: Record<ToolKey, PermissionLevel>;
}

const all = (level: PermissionLevel): Record<ToolKey, PermissionLevel> =>
  Object.fromEntries(TOOLS.map((t) => [t, level])) as Record<ToolKey, PermissionLevel>;

/** Built-in role templates seeded into every new tenant. */
export const BUILTIN_PERMISSION_TEMPLATES: PermissionTemplate[] = [
  {
    key: "project_admin",
    name: "Project Admin",
    description: "Full control of every tool on the project.",
    tools: all("admin"),
  },
  {
    key: "project_manager",
    name: "Project Manager",
    description: "Standard on all execution tools, admin on field tools.",
    tools: {
      ...all("standard"),
      workflow: "admin",
      rfis: "admin",
      submittals: "admin",
      daily_logs: "admin",
      punch: "admin",
      meetings: "admin",
      admin: "none",
      assurance: "none",
    },
  },
  {
    key: "field_engineer",
    name: "Field Engineer",
    description: "Create field records, read design records.",
    tools: {
      ...all("read"),
      rfis: "standard",
      daily_logs: "standard",
      punch: "standard",
      photos: "standard",
      documents: "standard",
      admin: "none",
      assurance: "none",
      budget: "none",
      commitments: "none",
      invoicing: "none",
    },
  },
  {
    key: "subcontractor",
    name: "Subcontractor",
    description: "Read the current set, respond to records assigned to them.",
    tools: {
      ...all("none"),
      drawings: "read",
      specifications: "read",
      documents: "read",
      rfis: "standard",
      submittals: "standard",
      daily_logs: "standard",
      punch: "standard",
      photos: "standard",
    },
  },
  {
    key: "owner_stakeholder",
    name: "Owner / Stakeholder",
    description: "Read-only visibility across execution and financial tools.",
    tools: {
      ...all("read"),
      admin: "none",
      ai: "read",
      assurance: "read",
    },
  },
  {
    key: "read_only",
    name: "Read Only",
    description: "Read everything except administration and assurance.",
    tools: { ...all("read"), admin: "none", assurance: "none" },
  },
];

const LEVEL_ORDER: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  standard: 2,
  admin: 3,
};

export function meetsLevel(actual: PermissionLevel, required: PermissionLevel): boolean {
  return LEVEL_ORDER[actual] >= LEVEL_ORDER[required];
}

/** Resolve effective level: explicit override beats template, template beats none. */
export function resolveLevel(
  tool: ToolKey,
  template: ToolPermissionMap | null | undefined,
  overrides: ToolPermissionMap | null | undefined,
): PermissionLevel {
  return overrides?.[tool] ?? template?.[tool] ?? "none";
}
