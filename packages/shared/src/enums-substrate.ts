/**
 * Shared enums for the substrate area (platform upgrade wave).
 *
 * The substrate is identity, directory, admin, projects, notifications,
 * workflow and search — the layer every other module stands on. These unions
 * are the vocabulary the substrate's new capabilities speak: soft delete and
 * the recycle bin, saved views, CSV import, retention and legal hold, data
 * export, delegated administration, notification preferences and the widened
 * workflow engine.
 *
 * Never edit enums.ts or permissions.ts from a work package; add here.
 */

/* ------------------------------------------------------------------ */
/* Soft delete / recycle bin (Vol I #78)                               */
/* ------------------------------------------------------------------ */

/**
 * Record types that carry `deletedAt`/`deletedBy` and are therefore
 * recoverable from the recycle bin rather than destroyed on delete.
 */
export const SOFT_DELETE_TYPES = ["project", "vendor", "contact"] as const;
export type SoftDeleteType = (typeof SOFT_DELETE_TYPES)[number];

/* ------------------------------------------------------------------ */
/* Saved views / filter sets (Vol I #75, #148)                          */
/* ------------------------------------------------------------------ */

/** `private` = visible to its owner only; `company` = shared with the tenant. */
export const SAVED_VIEW_SCOPES = ["private", "company"] as const;
export type SavedViewScope = (typeof SAVED_VIEW_SCOPES)[number];

/* ------------------------------------------------------------------ */
/* Notification preferences (Vol I #93–#97)                             */
/* ------------------------------------------------------------------ */

/** Where a notification of a given kind is allowed to land. */
export const NOTIFICATION_CHANNELS = ["in_app", "email", "none"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Digest cadence. `off` means "deliver each notification as it happens". */
export const NOTIFICATION_DIGESTS = ["off", "daily", "weekly"] as const;
export type NotificationDigest = (typeof NOTIFICATION_DIGESTS)[number];

/* ------------------------------------------------------------------ */
/* Retention, legal hold and export (Vol I #45–#47)                     */
/* ------------------------------------------------------------------ */

/** What happens to a record once its retention period elapses. */
export const RETENTION_ACTIONS = ["retain", "purge", "anonymise"] as const;
export type RetentionAction = (typeof RETENTION_ACTIONS)[number];

export const LEGAL_HOLD_STATUSES = ["active", "released"] as const;
export type LegalHoldStatus = (typeof LEGAL_HOLD_STATUSES)[number];

export const EXPORT_JOB_STATUSES = ["pending", "running", "complete", "failed"] as const;
export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Bulk import (Vol I #77)                                              */
/* ------------------------------------------------------------------ */

/** Datasets the substrate accepts as a CSV upload with a dry-run report. */
export const IMPORT_DATASETS = ["vendors", "contacts", "cost_codes", "locations"] as const;
export type ImportDataset = (typeof IMPORT_DATASETS)[number];

export const IMPORT_JOB_STATUSES = ["preview", "committed", "failed"] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Delegated administration (Vol I #27)                                 */
/* ------------------------------------------------------------------ */

/**
 * Capabilities a company owner/admin may delegate to a member for a bounded
 * set of projects, without making them a tenant-wide admin.
 */
export const ADMIN_DELEGATION_CAPABILITIES = [
  "memberships",
  "directory",
  "workflow_templates",
  "notifications",
] as const;
export type AdminDelegationCapability = (typeof ADMIN_DELEGATION_CAPABILITIES)[number];

/* ------------------------------------------------------------------ */
/* Workflow engine (Vol I #81–#92)                                      */
/* ------------------------------------------------------------------ */

/**
 * How a step names who must act. `user` is an explicit id list, `role` is a
 * permission-template key resolved against the project's memberships at
 * activation time (#83), `group` is a distribution group.
 */
export const WORKFLOW_ASSIGNEE_KINDS = ["user", "role", "group"] as const;
export type WorkflowAssigneeKind = (typeof WORKFLOW_ASSIGNEE_KINDS)[number];

/** ANY-of: the first decision settles the step. ALL-of: everyone must act. */
export const WORKFLOW_QUORUMS = ["any", "all"] as const;
export type WorkflowQuorum = (typeof WORKFLOW_QUORUMS)[number];

/**
 * Widened instance state. `blocked` is the fail-closed state an instance
 * enters when its step snapshot cannot be read or its assignees cannot be
 * resolved — the old engine silently approved in both cases. The column is
 * `text`, so this widens validation without touching enums.ts.
 */
export const WORKFLOW_INSTANCE_STATES = [
  "running",
  "approved",
  "rejected",
  "cancelled",
  "blocked",
] as const;
export type WorkflowInstanceState = (typeof WORKFLOW_INSTANCE_STATES)[number];

/** Condition operators a step may branch on (#82). */
export const WORKFLOW_CONDITION_OPS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "exists",
] as const;
export type WorkflowConditionOp = (typeof WORKFLOW_CONDITION_OPS)[number];

/* ------------------------------------------------------------------ */
/* Search (cross-package contract §3.3)                                 */
/* ------------------------------------------------------------------ */

/**
 * Record types the company-wide search covers out of the box. Modules may
 * add more at runtime through `registerSearchSource()`; this list is the
 * documented floor, not a closed set.
 */
export const SEARCH_RECORD_TYPES = [
  "project",
  "rfi",
  "submittal",
  "drawing_sheet",
  "document",
  "spec_section",
  "punch",
  "daily_log",
  "meeting",
  "commitment",
  "change_event",
  "invoice",
  "contract",
  "risk",
  "signal",
  "obligation",
  "vendor",
  "contact",
  "user",
  "lesson",
  "incident",
  "ncr",
  "equipment",
  "worker",
  "bid_package",
  "correspondence",
] as const;
export type SearchRecordType = (typeof SEARCH_RECORD_TYPES)[number];
