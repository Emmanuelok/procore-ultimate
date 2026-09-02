import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * Configurable approval workflow templates (spec Vol I §0.4).
 * `steps` is an ordered array of step definitions:
 *   { name, type: WorkflowStepType, assigneeIds?: string[], role?: string,
 *     parallel?: boolean, dueInDays?: number,
 *     condition?: { field: string, op: "eq"|"ne"|"gt"|"lt", value: unknown } }
 * Conditional branching is evaluated against the subject record's fields.
 */
export const workflowTemplates = pgTable(
  "workflow_templates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"), // null = company-wide template
    name: text("name").notNull(),
    recordType: text("record_type").notNull(), // which tool this template applies to
    version: integer("version").default(1).notNull(),
    steps: jsonb("steps").$type<unknown[]>().notNull(),
    isActive: integer("is_active").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("workflow_templates_company_idx").on(t.companyId),
    index("workflow_templates_record_idx").on(t.companyId, t.recordType, t.isActive),
  ],
);

export const workflowInstances = pgTable(
  "workflow_instances",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    templateId: text("template_id").notNull(),
    templateVersion: integer("template_version").notNull(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    status: text("status").default("running").notNull(), // WorkflowInstanceStatus
    currentPosition: integer("current_position").default(0).notNull(),
    /** field values captured at start; step conditions evaluate against this */
    context: jsonb("context").$type<Record<string, unknown>>().default({}).notNull(),
    startedBy: text("started_by").notNull(),
    /**
     * Why the instance is `blocked` (WorkflowInstanceState). The old engine
     * treated an unreadable step snapshot as "no steps left" and approved the
     * whole instance; it now fails closed into this state with the reason
     * recorded, and a workflow admin restarts or cancels it explicitly.
     */
    blockedReason: text("blocked_reason"),
    cancelledBy: text("cancelled_by"),
    cancelReason: text("cancel_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("workflow_instances_record_idx").on(t.recordType, t.recordId),
    index("workflow_instances_project_idx").on(t.projectId),
    index("workflow_instances_company_status_idx").on(t.companyId, t.status),
    // Uniqueness per record for LIVE instances: a double-click used to start
    // two independent approval chains on one RFI. Enforced in the engine as
    // an idempotent start (the running instance is returned), with this index
    // making the lookup cheap.
    index("workflow_instances_live_idx").on(t.companyId, t.recordType, t.recordId, t.status),
  ],
);

export const workflowStepInstances = pgTable(
  "workflow_step_instances",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id").notNull(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    stepType: text("step_type").notNull(), // WorkflowStepType
    assigneeId: text("assignee_id").notNull(),
    /** the user the step was delegated to, if any */
    delegatedToId: text("delegated_to_id"),
    /**
     * How this assignee was chosen (#83): "user" for an explicit id,
     * or the role/group key the engine resolved at activation. Kept so the
     * timeline can say "PM (Alice)" rather than just "Alice", and so a
     * retroactive template update knows which rows it may re-resolve.
     */
    assignedVia: text("assigned_via").default("user").notNull(), // WorkflowAssigneeKind
    assignedViaKey: text("assigned_via_key"),
    /** ANY-of vs ALL-of within the step's assignee set (WorkflowQuorum) */
    quorum: text("quorum").default("all").notNull(),
    decision: text("decision").default("pending").notNull(), // WorkflowStepDecision
    comments: text("comments"),
    dueDate: text("due_date"),
    /** #85 — when this step becomes an escalation, and whether it has been */
    escalateAt: text("escalate_at"),
    escalatedAt: timestamp("escalated_at", { withTimezone: true, mode: "string" }),
    /** last reminder sent, so the sweep does not renotify every cycle */
    remindedAt: timestamp("reminded_at", { withTimezone: true, mode: "string" }),
    reassignedFrom: text("reassigned_from"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("workflow_step_instances_idx").on(t.instanceId, t.position),
    // The inbox filters pending steps by assignee or delegate; without these
    // every user's inbox (and the shell badge behind it) scanned every step
    // row in the deployment.
    index("workflow_steps_assignee_idx").on(t.assigneeId, t.decision),
    index("workflow_steps_delegate_idx").on(t.delegatedToId, t.decision),
    index("workflow_steps_due_idx").on(t.decision, t.dueDate),
    uniqueIndex("workflow_steps_uq").on(t.instanceId, t.position, t.assigneeId),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    userId: text("user_id").notNull(),
    projectId: text("project_id"),
    kind: text("kind").notNull(), // NotificationKind
    title: text("title").notNull(),
    body: text("body"),
    recordType: text("record_type"),
    recordId: text("record_id"),
    readAt: timestamp("read_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.readAt),
    // The centre lists by (companyId, userId) newest-first; the index above
    // does not serve that ordering.
    index("notifications_feed_idx").on(t.companyId, t.userId, t.createdAt),
    index("notifications_digest_idx").on(t.companyId, t.userId, t.kind, t.createdAt),
  ],
);

/* ================================================================== */
/* Platform upgrade wave — WP-SUBSTRATE notification policy            */
/* ================================================================== */

/**
 * Per-user notification preferences (Vol I #93–#97).
 *
 * One row per user per tenant. `kinds` maps a NotificationKind to a
 * NotificationChannel; anything absent falls back to `defaultChannel`. Muting
 * is by project and by tool, and the digest cadence decides whether a kind
 * arrives immediately or is rolled into the next digest.
 *
 * Preferences are a POLICY over `pushNotifications`, not a second delivery
 * path: a suppressed notification is not written at all, and a digested one
 * is written but held back from the "new since you last looked" count until
 * the digest goes out.
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    userId: text("user_id").notNull(),
    defaultChannel: text("default_channel").default("in_app").notNull(), // NotificationChannel
    digest: text("digest").default("off").notNull(), // NotificationDigest
    /** kind -> NotificationChannel */
    kinds: jsonb("kinds").$type<Record<string, string>>().default({}).notNull(),
    mutedProjectIds: jsonb("muted_project_ids").$type<string[]>().default([]).notNull(),
    mutedTools: jsonb("muted_tools").$type<string[]>().default([]).notNull(),
    /** quiet hours in the user's local offset, e.g. { start: 20, end: 7 } */
    quietHours: jsonb("quiet_hours").$type<Record<string, unknown> | null>(),
    lastDigestAt: timestamp("last_digest_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("notification_preferences_uq").on(t.companyId, t.userId)],
);
