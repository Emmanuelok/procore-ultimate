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
  IconAi,
  IconApproval,
  IconAssurance,
  IconAudit,
  IconBell,
  IconBenchmark,
  IconDashboard,
  IconDirectory,
  IconDispute,
  IconFinance,
  IconIngestion,
  IconInsight,
  IconIntegration,
  IconLearning,
  IconLedger,
  IconProcurement,
  IconProject,
  IconSearch,
  IconSecurity,
  IconZap,
  type IconComponent,
} from "../../ui/icons";
import { PROJECT_NAV_ITEMS } from "../project/nav";

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
 * FIVE GROUPS, and the three the route table calls canonical are Overview,
 * Assurance and Platform. Directory and Admin predate them and hold entries
 * the table does not cover (the directory itself, notifications, permissions).
 *
 * A "Financials" group is still deliberately absent. Budget, prime contracts,
 * commitments, change management and invoicing are all PROJECT-scoped
 * (`/projects/:projectId/budget`, …), so there is nothing company-wide for
 * such a group to link to; they are reachable from the project navigation and
 * from the command palette once a project is chosen. The two company-level
 * money routes that DO exist — `/portfolio` (what has been authorised across
 * the programme) and `/finance-portfolio` (lender exposure across it) — are
 * portfolio questions rather than project accounting, which is why they sit
 * in Overview beside the dashboard rather than in a group of their own.
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
      {
        to: "/pulse",
        label: "Pulse",
        icon: IconInsight,
        description: "Health, the attention feed and what changed",
        keywords: ["pulse", "health", "attention", "briefing", "portfolio", "what changed"],
      },
      {
        to: "/workflows",
        label: "Approvals",
        icon: IconApproval,
        description: "Your approval inbox, running instances and templates",
        keywords: [
          "workflow",
          "approval",
          "inbox",
          "delegate",
          "reassign",
          "escalation",
          "template",
          "designer",
        ],
      },
      {
        to: "/search",
        label: "Search",
        icon: IconSearch,
        description: "Every record you may see, refined rather than skimmed",
        keywords: ["search", "find", "record", "global", "palette"],
      },
      {
        to: "/portfolio",
        label: "Portfolio",
        icon: IconProcurement,
        description: "Funding, appropriations, affordability and frameworks",
        keywords: [
          "portfolio",
          "programme",
          "funding",
          "appropriation",
          "allocation",
          "affordability",
          "envelope",
          "prioritisation",
          "mcda",
          "framework",
          "call-off",
          "term contract",
          "schedule of rates",
        ],
      },
      {
        to: "/finance-portfolio",
        label: "Lender exposure",
        icon: IconFinance,
        description: "Facilities, lenders and closing dates across the portfolio",
        keywords: [
          "facilities",
          "lenders",
          "debt",
          "grant",
          "disbursement",
          "closing date",
          "covenants",
          "draw stop",
        ],
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
        to: "/assurance-reviews",
        label: "Gate reviews",
        icon: IconAudit,
        description: "Gates due, conditions of approval and assurance actions",
        keywords: [
          "gate",
          "gateway",
          "review",
          "assurance",
          "conditions",
          "actions",
          "governance",
          "independent reviewer",
        ],
      },
      {
        to: "/benchmarks",
        label: "Benchmarks",
        icon: IconBenchmark,
        description: "Metric catalogue, snapshots and distributions",
        keywords: [
          "metrics",
          "compare",
          "distribution",
          "percentile",
          "reference class",
          "forecast",
        ],
      },
      {
        to: "/dispute-outcomes",
        label: "Dispute outcomes",
        icon: IconDispute,
        description: "Win rates, awards and the clauses behind them",
        keywords: ["disputes", "win rate", "awards", "root cause", "forum", "clauses", "drafting"],
      },
      {
        to: "/learning",
        label: "Learning",
        icon: IconLearning,
        description: "Lessons captured, applied and reviewed",
        keywords: [
          "lessons",
          "knowledge",
          "capture",
          "review",
          "libraries",
          "rates",
          "durations",
          "onboarding",
        ],
      },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    items: [
      {
        to: "/ingestion",
        label: "Ingestion",
        icon: IconIngestion,
        description: "Sources, runs and import tokens",
        keywords: [
          "import",
          "sources",
          "runs",
          "etl",
          "upload",
          "programme",
          "p6",
          "xer",
          "msp",
          "templates",
          "reconcile",
        ],
      },
      {
        to: "/integrations",
        label: "Integrations",
        icon: IconIntegration,
        description: "Webhooks, OAuth clients and delivery health",
        keywords: [
          "webhooks",
          "oauth",
          "api",
          "connectors",
          "delivery",
          "erp",
          "export",
          "sandbox",
          "openapi",
          "mcp",
        ],
      },
      {
        to: "/automation",
        label: "Automation",
        icon: IconZap,
        description: "Rules, templates, runs and the engine's health",
        keywords: ["rules", "workflow", "triggers", "escalation", "webhooks", "automation"],
      },
      {
        to: "/agents",
        label: "AI Agents",
        icon: IconAi,
        description: "The fleet, the review queue, rollback and governance",
        keywords: [
          "ai",
          "agents",
          "fleet",
          "policy",
          "review queue",
          "rollback",
          "schedules",
          "governance",
          "bias",
          "adversarial",
          "validation",
          "models",
          "transparency",
        ],
      },
      {
        to: "/security",
        label: "Security",
        icon: IconSecurity,
        description: "Policy, sessions, IP allowlist, SCIM, retention and audit",
        keywords: [
          "security",
          "policy",
          "password",
          "session",
          "ip allowlist",
          "mfa",
          "scim",
          "webhooks",
          "audit",
          "retention",
          "legal hold",
        ],
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
        keywords: ["permissions", "roles", "settings", "access"],
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
  pulse: "Pulse",
  workflows: "Approvals",
  search: "Search",
  portfolio: "Portfolio",
  "finance-portfolio": "Lender exposure",
  "assurance-reviews": "Gate reviews",
  "dispute-outcomes": "Dispute outcomes",
  automation: "Automation",
  agents: "AI Agents",
  security: "Security",
  account: "Account",

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

  /* WP-SHELL project workspaces. `portfolio` and `automation` are shared with
     the company segments above — same word, same meaning, one label each. */
  correspondence: "Correspondence",
  design: "Design",
  observations: "Observations",
  site: "Site Operations",
  "supply-chain": "Supply Chain",
  resources: "Resources",
  estimating: "Estimating",
  tax: "Tax & Deductions",
  intelligence: "Intelligence",
};

/** Every project-scoped destination the palette can jump straight into. */
export interface ProjectDestination {
  segment: string;
  label: string;
}

/**
 * Derived from the project navigation rather than hand-maintained.
 *
 * This list used to be a curated literal, and it drifted: workspaces were
 * routed and given a project nav entry while the palette kept offering the
 * same nineteen destinations. Deriving it means the palette can never offer a
 * jump to a route that does not exist (PROJECT_NAV_ITEMS is itself bound by
 * project/nav.ts's ONE RULE), and never miss one that does. Detail routes
 * (`drawings/:sheetId`, `bim/:modelId`, `contracts/:contractId`) are absent
 * because they are absent from the nav — you cannot jump to a record without
 * knowing which record.
 */
export const PROJECT_DESTINATIONS: readonly ProjectDestination[] = PROJECT_NAV_ITEMS.map(
  (item) => ({ segment: item.to, label: item.label }),
);

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
