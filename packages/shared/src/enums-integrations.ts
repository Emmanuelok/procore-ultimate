import { INGESTION_DATASETS, type IngestionDataset } from "./enums.js";

/**
 * Shared enums for the integrations area (platform upgrade wave).
 * Add new `as const` string unions and their types here; never edit
 * enums.ts from a parallel work package.
 */

/**
 * The canonical feeds an ERP profile can render (#130-133). The SYSTEM
 * vocabulary is ERP_SYSTEMS from enums-financials.ts — sage, quickbooks,
 * viewpoint, xero, oracle, sap, other — reused rather than restated, so a
 * profile and a financial ERP reference name the same system.
 */
export const ERP_FEEDS = ["ap_invoices", "job_cost", "payments"] as const;
export type ErpFeed = (typeof ERP_FEEDS)[number];

export const ERP_EXPORT_FORMATS = ["csv", "json"] as const;
export type ErpExportFormat = (typeof ERP_EXPORT_FORMATS)[number];

/**
 * Model Context Protocol (#126-127). The tool names an MCP client may call;
 * each maps to a ConstructOS tool permission and goes through the same gate a
 * human does — an MCP session is never a second, softer door.
 */
export const MCP_TOOL_NAMES = [
  "search",
  "get_record",
  "list_signals",
  "list_obligations",
  "project_health",
  "list_projects",
  "create_rfi",
  "create_observation",
  "run_detectors",
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Which parser produced an ingestion run's staged rows. */
export const INGESTION_PARSERS = ["csv", "p6_xer", "msp_xml", "connector", "push"] as const;
export type IngestionParser = (typeof INGESTION_PARSERS)[number];

/** How an ingestion run treats a row that matches an already-committed record. */
export const INGESTION_MODES = ["insert", "reconcile"] as const;
export type IngestionMode = (typeof INGESTION_MODES)[number];

/** The operator's decision on a reconciled row. */
export const INGESTION_RESOLUTIONS = ["insert", "update", "skip"] as const;
export type IngestionResolution = (typeof INGESTION_RESOLUTIONS)[number];

/**
 * The datasets the platform-upgrade wave added to the migration wizard.
 *
 * They are ordinary members of `INGESTION_DATASETS` in enums.ts — the ONE
 * vocabulary the dataset registry (`Record<IngestionDataset, DatasetDef>`),
 * the commit-writer switch, token scopes and the run filters are typed
 * against. This list only records which members arrived with the wave;
 * `satisfies` refuses any entry that is not in the canonical enum, so it can
 * never grow back into a second vocabulary. (It briefly was one: the registry
 * read the union of two enums, and the API described datasets the base enum
 * did not know.)
 */
export const EXTENDED_INGESTION_DATASETS = [
  "cost_codes",
  "budget_lines",
] as const satisfies readonly IngestionDataset[];
export type ExtendedIngestionDataset = (typeof EXTENDED_INGESTION_DATASETS)[number];

/** @deprecated Alias of `INGESTION_DATASETS` (enums.ts), kept for callers written against it. */
export const ALL_INGESTION_DATASETS = INGESTION_DATASETS;
/** @deprecated Alias of `IngestionDataset` (enums.ts). */
export type AnyIngestionDataset = IngestionDataset;
