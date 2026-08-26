/**
 * The project workspace navigation model.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * The project view used to render 27 destinations as a single wrapping row of
 * tabs. That does not scale, it wraps to three lines on a laptop, and it gives
 * a construction professional no map of the product. This file replaces it
 * with the grouping a delivery team already thinks in — Documents, Field,
 * Schedule, Financials, Risk & Governance, Safeguards, Insight — rendered by
 * `ProjectNav` as a collapsible two-level sidebar that scales past 30
 * destinations without wrapping anything.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE
 *
 * EVERY ENTRY HERE MUST RESOLVE TO A ROUTE THAT EXISTS. A nav link to a 404 is
 * worse than an absent link: it teaches people the product is broken.
 *
 * The API has modules with no web page yet — specifications, meetings, safety,
 * quality, equipment, timecards, bidding. They are deliberately NOT listed
 * here, and this comment is the record of that decision so the next person
 * does not "fix" the omission. Add the entry in the same change that adds the
 * page and its route, not before.
 *
 * `to` is relative to /projects/:projectId.
 */
import {
  IconAi,
  IconAnalytics,
  IconAssurance,
  IconBim,
  IconBudget,
  IconChangeOrder,
  IconCommitment,
  IconCompliance,
  IconContract,
  IconCost,
  IconDailyLog,
  IconDashboard,
  IconDispute,
  IconDocument,
  IconDrawing,
  IconEsg,
  IconFinance,
  IconFolder,
  IconForensics,
  IconGantt,
  IconGovernance,
  IconInsight,
  IconInsurance,
  IconInvoice,
  IconJurisdiction,
  IconLand,
  IconPayment,
  IconPhoto,
  IconPunch,
  IconRfi,
  IconRisk,
  IconSchedule,
  IconSite,
  IconSpreadsheet,
  IconStamp,
  IconSubmittal,
  IconTwin,
  IconWorkforce,
  type IconComponent,
} from "../../ui/icons";

export interface ProjectNavItem {
  /** Path relative to /projects/:projectId. "" is the overview. */
  to: string;
  label: string;
  icon: IconComponent;
  /** Match the route exactly (the index route only). */
  end?: boolean;
  /** Words the section filter should also match on. */
  keywords?: string;
}

export interface ProjectNavGroup {
  id: string;
  label: string;
  icon: IconComponent;
  items: ProjectNavItem[];
}

/** The single destination that sits above the groups. */
export const OVERVIEW_ITEM: ProjectNavItem = {
  to: "",
  label: "Overview",
  icon: IconDashboard,
  end: true,
  keywords: "home dashboard summary command centre",
};

export const PROJECT_NAV_GROUPS: readonly ProjectNavGroup[] = [
  {
    id: "documents",
    label: "Documents",
    icon: IconFolder,
    items: [
      { to: "drawings", label: "Drawings", icon: IconDrawing, keywords: "sheets plans markup" },
      { to: "documents", label: "Documents", icon: IconDocument, keywords: "files folders" },
      { to: "bim", label: "BIM", icon: IconBim, keywords: "models ifc clash" },
      { to: "twin", label: "Digital Twin", icon: IconTwin, keywords: "assets handover" },
    ],
  },
  {
    id: "field",
    label: "Field",
    icon: IconSite,
    items: [
      { to: "rfis", label: "RFIs", icon: IconRfi, keywords: "requests for information" },
      { to: "submittals", label: "Submittals", icon: IconSubmittal, keywords: "shop drawings" },
      { to: "daily-logs", label: "Daily Logs", icon: IconDailyLog, keywords: "diary weather" },
      { to: "punch", label: "Punch", icon: IconPunch, keywords: "snagging defects" },
      { to: "photos", label: "Photos", icon: IconPhoto, keywords: "images site record" },
    ],
  },
  {
    id: "schedule",
    label: "Schedule",
    icon: IconSchedule,
    items: [
      {
        to: "schedule",
        label: "Schedule",
        icon: IconGantt,
        keywords: "programme gantt cpm baseline lookahead",
      },
    ],
  },
  {
    id: "financials",
    label: "Financials",
    icon: IconCost,
    items: [
      { to: "budget", label: "Budget", icon: IconBudget, keywords: "cost forecast wbs" },
      {
        to: "prime-contract",
        label: "Prime Contract",
        icon: IconContract,
        keywords: "owner sov g702 g703 billing",
      },
      {
        to: "commitments",
        label: "Commitments",
        icon: IconCommitment,
        keywords: "subcontracts purchase orders buyout",
      },
      {
        to: "changes",
        label: "Change Management",
        icon: IconChangeOrder,
        keywords: "pco cor variation change order",
      },
      {
        to: "invoicing",
        label: "Invoicing",
        icon: IconInvoice,
        keywords: "applications billing retainage lien waiver",
      },
      {
        to: "commercial",
        label: "Commercial",
        icon: IconSpreadsheet,
        keywords: "boq valuations certificates",
      },
      { to: "payments", label: "Payments", icon: IconPayment, keywords: "cash remittance" },
    ],
  },
  {
    id: "risk-governance",
    label: "Risk & Governance",
    icon: IconRisk,
    items: [
      { to: "risk", label: "Risk", icon: IconRisk, keywords: "register qcra montecarlo" },
      {
        to: "governance",
        label: "Governance",
        icon: IconGovernance,
        keywords: "stage gates business case benefits",
      },
      { to: "finance", label: "Finance", icon: IconFinance, keywords: "facilities covenants" },
      { to: "disputes", label: "Disputes", icon: IconDispute, keywords: "adjudication settlement" },
      {
        to: "forensics",
        label: "Forensics",
        icon: IconForensics,
        keywords: "delay analysis claims",
      },
      {
        to: "contracts",
        label: "Contracts",
        icon: IconStamp,
        keywords: "nec fidic clauses eot notices",
      },
      { to: "insurance", label: "Insurance", icon: IconInsurance, keywords: "bonds certificates" },
    ],
  },
  {
    id: "safeguards",
    label: "Safeguards",
    icon: IconCompliance,
    items: [
      { to: "land", label: "Land", icon: IconLand, keywords: "community acquisition grievance" },
      {
        to: "workforce",
        label: "Workforce",
        icon: IconWorkforce,
        keywords: "labour welfare recruitment",
      },
      { to: "esg", label: "ESG", icon: IconEsg, keywords: "carbon waste social value" },
      {
        to: "jurisdiction",
        label: "Jurisdiction",
        icon: IconJurisdiction,
        keywords: "permits regulatory local content",
      },
    ],
  },
  {
    id: "insight",
    label: "Insight",
    icon: IconInsight,
    items: [
      {
        to: "analytics",
        label: "Analytics",
        icon: IconAnalytics,
        keywords: "reports dashboards",
      },
      {
        to: "assurance",
        label: "Assurance",
        icon: IconAssurance,
        keywords: "evidence signals obligations ledger",
      },
      { to: "ai", label: "AI", icon: IconAi, keywords: "assistant copilot answers" },
    ],
  },
];

/** Every destination, flattened — used by the filter and the mobile drawer. */
export const PROJECT_NAV_ITEMS: readonly ProjectNavItem[] = [
  OVERVIEW_ITEM,
  ...PROJECT_NAV_GROUPS.flatMap((group) => group.items),
];

/** Which group owns a path segment, so the sidebar can auto-open it. */
export function groupIdForPath(segment: string): string | null {
  for (const group of PROJECT_NAV_GROUPS) {
    if (group.items.some((item) => item.to === segment)) return group.id;
  }
  return null;
}

/** The nav entry matching the current URL, for the header breadcrumb. */
export function navItemForPath(segment: string): ProjectNavItem | null {
  if (segment === "") return OVERVIEW_ITEM;
  return PROJECT_NAV_ITEMS.find((item) => item.to !== "" && item.to === segment) ?? null;
}

/** Case-insensitive match over label and keywords. */
export function matchesFilter(item: ProjectNavItem, needle: string): boolean {
  if (!needle) return true;
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return (
    item.label.toLowerCase().includes(q) || (item.keywords ?? "").toLowerCase().includes(q)
  );
}
