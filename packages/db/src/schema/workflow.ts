import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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
  (t) => [index("workflow_templates_company_idx").on(t.companyId)],
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
    startedBy: text("started_by").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("workflow_instances_record_idx").on(t.recordType, t.recordId),
    index("workflow_instances_project_idx").on(t.projectId),
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
    decision: text("decision").default("pending").notNull(), // WorkflowStepDecision
    comments: text("comments"),
    dueDate: text("due_date"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [index("workflow_step_instances_idx").on(t.instanceId, t.position)],
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
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt)],
);
