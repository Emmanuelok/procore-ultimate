/**
 * shell/nav.ts — the company-level navigation model.
 *
 * One declarative list drives three surfaces so they can never drift:
 *
 *   • the sidebar (grouped, with icons, tooltips and badge counts)
 *   • the breadcrumb trail in the top bar
 *   • the command palette's "Navigation" group
 *
 * Every `to` here MUST correspond to a route registered in src/App.tsx. A nav
 * entry that points at nothing is worse than a missing one, so groups whose
 * routes do not exist are simply absent — see FINANCIALS below.
 */
import {
  IconAdmin,
  IconAssurance,
  IconBell,
  IconBenchmark,
  IconDashboard,
  IconDirectory,
  IconIngestion,
  IconIntegration,
  IconLearning,
  IconLedger,
  IconProject,
  type IconComponent,
} from "../../ui/icons";

/** Which live counter, if any, decorates an entry. */
export type NavBadgeKey = "notifications" | "signals";

export interface NavItem {
  to: string;
  label: string;
  icon: IconComponent;
  /** Match the path exactly (only the dashboard at "/"). */
  end?: boolean;
  /** Live counter to render as a badge. Absent ⇒ never a badge. */
  badge?: NavBadgeKey;
  /** Second line in the command palette. */
  description?: string;
  /** Extra terms the palette should score against. */
  keywords?: string[];
}

export interface NavGroup {
  id: string;
  label: string;
  items: readonly NavItem[];
}

/**
 * FINANCIALS is deliberately absent.
 *
 * Budget, prime contracts, commitments, change management and invoicing are
 * all PROJECT-scoped (`/projects/:projectId/budget`, …). There is no
 * company-level financial route in App.tsx and no company-level financial
 * endpoint in the API, so there is nothing for a "Financials" group to link
 * to. Those workspaces are reachable from the project navigation and from the
 * command palette once a project is chosen.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      {
        to: "/",
        label: "Dashboard",
        icon: IconDashboard,
        end: true,
        description: "Portfolio KPIs, signals and activity",
        keywords: ["home", "portfolio", "overview", "kpi"],
      },
      {
        to: "/projects",
        label: "Projects",
        icon: IconProject,
        description: "Every project in this company",
        keywords: ["portfolio", "jobs", "sites"],
      },
    ],
  },
  {
    id: "directory",
    label: "Directory",
    items: [
      {
        to: "/directory",
        label: "Directory",
        icon: IconDirectory,
        description: "Vendors, contacts and company users",
        keywords: ["vendors", "contacts", "people", "users", "subcontractors"],
      },
    ],
  },
  {
    id: "assurance",
    label: "Assurance",
    items: [
      {
        to: "/assurance",
        label: "Assurance",
        icon: IconAssurance,
        badge: "signals",
        description: "Entities, relationships and integrity signals",
        keywords: ["signals", "entities", "integrity", "evidence", "detectors"],
      },
      {
        to: "/ledger",
        label: "Ledger",
        icon: IconLedger,
        description: "Hash-chained audit trail, seals and anchors",
        keywords: ["audit", "chain", "anchor", "seal", "escrow", "verify"],
      },
      {
        to: "/benchmarks",
        label: "Benchmarks",
        icon: IconBenchmark,
        description: "Metric catalogue, snapshots and distributions",
        keywords: ["metrics", "compare", "distribution", "percentile"],
      },
      {
        to: "/learning",
        label: "Learning",
        icon: IconLearning,
        description: "Lessons captured, applied and reviewed",
        keywords: ["lessons", "knowledge", "capture", "review"],
      },
    ],
  },
  {
    id: "data",
    label: "Data",
    items: [
      {
        to: "/ingestion",
        label: "Ingestion",
        icon: IconIngestion,
        description: "Sources, runs and import tokens",
        keywords: ["import", "sources", "runs", "etl", "upload"],
      },
      {
        to: "/integrations",
        label: "Integrations",
        icon: IconIntegration,
        description: "Webhooks, OAuth clients and delivery health",
        keywords: ["webhooks", "oauth", "api", "connectors", "delivery"],
      },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    items: [
      {
        to: "/notifications",
        label: "Notifications",
        icon: IconBell,
        badge: "notifications",
        description: "Everything addressed to you",
        keywords: ["inbox", "alerts", "mentions"],
      },
      {
        to: "/admin",
        label: "Admin",
        icon: IconAdmin,
        description: "Permission templates, grants and auth events",
        keywords: ["permissions", "roles", "security", "settings", "access"],
      },
    ],
  },
];

/** Flat list, in sidebar order. */
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/**
 * Human labels for the path segments the breadcrumb trail walks over.
 * Project sub-routes live here too — the project tabs are owned by
 * ProjectLayout, but the trail above them is the shell's job.
 */
export const SEGMENT_LABELS: Readonly<Record<string, string>> = {
  projects: "Projects",
  directory: "Directory",
  assurance: "Assurance",
  ingestion: "Ingestion",
  benchmarks: "Benchmarks",
  ledger: "Ledger",
  learning: "Learning",
  integrations: "Integrations",
  notifications: "Notifications",
  admin: "Admin",

  /* project workspaces */
  documents: "Documents",
  drawings: "Drawings",
  bim: "BIM",
  twin: "Digital Twin",
  rfis: "RFIs",
  submittals: "Submittals",
  "daily-logs": "Daily Logs",
  punch: "Punch",
  photos: "Photos",
  schedule: "Schedule",
  risk: "Risk",
  land: "Land & Community",
  workforce: "Workforce",
  esg: "ESG & Carbon",
  jurisdiction: "Jurisdiction",
  insurance: "Insurance & Bonds",
  analytics: "Analytics",
  governance: "Governance",
  finance: "Finance",
  disputes: "Disputes",
  forensics: "Forensics",
  payments: "Payments",
  commercial: "Commercial",
  contracts: "Contracts",
  ai: "AI",

  /* the financial suite */
  budget: "Budget",
  "prime-contract": "Prime Contract",
  commitments: "Commitments",
  changes: "Change Management",
  invoicing: "Invoicing",

  /* Procore-parity workspaces (M19–M25) */
  specifications: "Specifications",
  meetings: "Meetings",
  safety: "Safety",
  quality: "Quality",
  equipment: "Equipment",
  timecards: "Timecards",
  bidding: "Bidding",
};

/** Every project-scoped destination the palette can jump straight into. */
export interface ProjectDestination {
  segment: string;
  label: string;
}

export const PROJECT_DESTINATIONS: readonly ProjectDestination[] = [
  { segment: "", label: "Overview" },
  { segment: "budget", label: "Budget" },
  { segment: "prime-contract", label: "Prime Contract" },
  { segment: "commitments", label: "Commitments" },
  { segment: "changes", label: "Change Management" },
  { segment: "invoicing", label: "Invoicing" },
  { segment: "rfis", label: "RFIs" },
  { segment: "submittals", label: "Submittals" },
  { segment: "drawings", label: "Drawings" },
  { segment: "schedule", label: "Schedule" },
  { segment: "documents", label: "Documents" },
  { segment: "assurance", label: "Assurance" },
  { segment: "specifications", label: "Specifications" },
  { segment: "meetings", label: "Meetings" },
  { segment: "safety", label: "Safety" },
  { segment: "quality", label: "Quality" },
  { segment: "equipment", label: "Equipment" },
  { segment: "timecards", label: "Timecards" },
  { segment: "bidding", label: "Bidding" },
];

/** Title Case fallback for a segment with no explicit label. */
export function segmentLabel(segment: string): string {
  const known = SEGMENT_LABELS[segment];
  if (known) return known;
  return segment
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
