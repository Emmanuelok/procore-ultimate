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
 * Specifications, meetings, safety, quality, equipment, timecards and bidding
 * were listed here as deliberately absent, "add the entry in the same change
 * that adds the page and its route, not before". Those seven workspaces
 * shipped complete and then sat unreachable: no import in App.tsx, no route,
 * no chunk in the bundle. This is that change — routes first (App.tsx), then
 * these entries. The rule stands for whatever comes next.
 *
 * WP-SHELL then did the same for eleven more: correspondence, design,
 * observations, site, supply-chain, resources, estimating, tax, portfolio,
 * intelligence and automation. Routes went into App.tsx in the same change.
 * The company palette's PROJECT_DESTINATIONS is now DERIVED from
 * PROJECT_NAV_ITEMS below rather than hand-listed, so the palette cannot
 * drift from this file the way it silently had.
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
  IconClock,
  IconCommitment,
  IconCompass,
  IconCompliance,
  IconContract,
  IconCost,
  IconDailyLog,
  IconDashboard,
  IconDispute,
  IconDocument,
  IconDrawing,
  IconEquipment,
  IconEsg,
  IconFinance,
  IconFolder,
  IconForensics,
  IconGantt,
  IconGovernance,
  IconInsight,
  IconInspection,
  IconInsurance,
  IconInvoice,
  IconJurisdiction,
  IconLand,
  IconLayers,
  IconMail,
  IconMeeting,
  IconPayment,
  IconPhoto,
  IconProcurement,
  IconPunch,
  IconQuality,
  IconRfi,
  IconRisk,
  IconRuler,
  IconSafety,
  IconSchedule,
  IconSite,
  IconSpec,
  IconSpreadsheet,
  IconStamp,
  IconSubmittal,
  IconTwin,
  IconUsers,
  IconWorkforce,
  IconZap,
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
      {
        to: "specifications",
        label: "Specifications",
        icon: IconSpec,
        keywords: "spec book sections requirements divisions csi uniclass coverage",
      },
      {
        to: "correspondence",
        label: "Correspondence",
        icon: IconMail,
        keywords:
          "correspondence letters transmittals action plans forms inbound email acknowledgement notice instruction eot sign-off checklist",
      },
      {
        to: "design",
        label: "Design",
        icon: IconCompass,
        keywords:
          "design management packages stages riba aia iso 19650 reviews comments status codes issues decisions consultants deliverables tidp midp change notice dcn freeze eir bep readiness handover",
      },
      {
        to: "bim",
        label: "BIM",
        icon: IconBim,
        keywords: "models ifc clash coordination federation reality capture map geofence",
      },
      {
        to: "twin",
        label: "Digital Twin",
        icon: IconTwin,
        keywords: "assets sensors warranties handover cobie milestones performance",
      },
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
      {
        to: "observations",
        label: "Observations",
        icon: IconInspection,
        keywords: "field findings snags safety quality observations pins",
      },
      { to: "photos", label: "Photos", icon: IconPhoto, keywords: "images site record" },
      {
        to: "site",
        label: "Site Operations",
        icon: IconSite,
        keywords:
          "site induction pass gate turnstile register muster attendance permit to work hot work confined space exclusion zone lone worker weather exceptional weather drone scan point cloud deviation 360 tour survey setting out control point borehole geotechnical ground conditions utility buried services strike seismic tidal progress observation site plan",
      },
      {
        to: "safety",
        label: "Safety",
        icon: IconSafety,
        keywords:
          "incidents observations riddor osha 300 log toolbox talks corrective actions device alarms lone worker statutory forms f2508 risk index under-reporting vendor scorecard",
      },
      {
        to: "quality",
        label: "Quality",
        icon: IconQuality,
        keywords:
          "itp hold points checklists ncr commissioning turnover concessions concrete welding ndt material certificates calibration rework cost of quality audits iso 9001 defects liability performance guarantees",
      },
      {
        to: "meetings",
        label: "Meetings",
        icon: IconMeeting,
        keywords:
          "minutes agenda decisions actions quorum carry-forward objections distribution",
      },
      {
        to: "equipment",
        label: "Equipment",
        icon: IconEquipment,
        keywords:
          "plant hire certificates maintenance telematics materials idle stock deliveries",
      },
      {
        to: "supply-chain",
        label: "Supply Chain",
        icon: IconProcurement,
        keywords:
          "long lead procurement expediting deliveries slot booking site gate crane offsite modular dfma factory qa vesting traceability heat batch mill certificate supplier risk sole source logistics",
      },
      {
        to: "timecards",
        label: "Timecards",
        icon: IconClock,
        keywords: "labour hours crews overtime t&m tickets payroll certified batches",
      },
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
        keywords:
          "programme gantt cpm baseline lookahead calendar earned value dcma p6 xer mspdi import milestone constraint narrative",
      },
      {
        to: "resources",
        label: "Resources",
        icon: IconUsers,
        keywords:
          "resource plan demand supply histogram levelling crew calendar assignment conflict productivity earned hours measured mile utilisation skills certifications matrix trades plant classes library",
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
        keywords: "owner sov g702 g703 billing aia export certificate",
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
        keywords:
          "boq bill of quantities valuation certificate variation daywork retention cvr final account",
      },
      { to: "payments", label: "Payments", icon: IconPayment, keywords: "cash remittance" },
      {
        to: "bidding",
        label: "Bidding",
        icon: IconProcurement,
        keywords:
          "tender packages invitations sealed bids levelling award prequalification opportunities pipeline win rate integrity bid bonds",
      },
      {
        to: "estimating",
        label: "Estimating",
        icon: IconRuler,
        keywords:
          "estimate takeoff measurement quantity scale calibration rate catalogue assembly crew production rate markup overhead profit contingency proposal sub-quote levelling budget conversion change order",
      },
      {
        to: "tax",
        label: "Tax & Deductions",
        icon: IconFinance,
        keywords:
          "tax vat gst cis rct withholding wht tds reverse charge returns permanent establishment deductions",
      },
      {
        // WP-PORTFOLIO reported this as "Commercial structures", which sat one
        // row from "Commercial" (the BoQ / valuation workspace) in this very
        // group and read as a sub-page of it. Same route, clearer name.
        to: "portfolio",
        label: "Delivery Structures",
        icon: IconLayers,
        keywords:
          "call-off framework joint venture jv consortium spv alliance target cost pain gain open book defined cost disallowed cost audit rights commercial structures",
      },
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
        keywords:
          "delay analysis claims tia windows concurrency quantum disruption measured mile scott schedule prolongation",
      },
      {
        to: "contracts",
        label: "Contracts",
        icon: IconStamp,
        keywords: "nec fidic clauses eot notices time bar compensation event ld compliance",
      },
      {
        to: "insurance",
        label: "Insurance",
        icon: IconInsurance,
        keywords: "bonds certificates policies claims cover gap facility renewal",
      },
    ],
  },
  {
    id: "safeguards",
    label: "Safeguards",
    icon: IconCompliance,
    items: [
      {
        to: "land",
        label: "Land",
        icon: IconLand,
        keywords: "community acquisition grievance resettlement rap triage",
      },
      {
        to: "workforce",
        label: "Workforce",
        icon: IconWorkforce,
        keywords: "labour welfare recruitment grievance wages rest day modern slavery",
      },
      {
        to: "esg",
        label: "ESG",
        icon: IconEsg,
        keywords: "carbon waste social value biodiversity disclosure",
      },
      {
        to: "jurisdiction",
        label: "Jurisdiction",
        icon: IconJurisdiction,
        keywords: "permits regulatory local content currency consolidation",
      },
    ],
  },
  {
    id: "insight",
    label: "Insight",
    icon: IconInsight,
    items: [
      {
        to: "intelligence",
        label: "Intelligence",
        icon: IconInsight,
        keywords: "health score attention briefing agents dimensions",
      },
      {
        to: "analytics",
        label: "Analytics",
        icon: IconAnalytics,
        keywords: "reports dashboards forecasts insights runs",
      },
      {
        to: "assurance",
        label: "Assurance",
        icon: IconAssurance,
        keywords: "evidence signals obligations ledger",
      },
      { to: "ai", label: "AI", icon: IconAi, keywords: "assistant copilot answers" },
      {
        to: "automation",
        label: "Automation",
        icon: IconZap,
        keywords: "rules workflow triggers escalation automation",
      },
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
