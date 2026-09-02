/**
 * Request validation for the automation module. Every shape a rule is made of
 * is checked here, including per-action parameter validation, so a rule that
 * reaches the engine is one the engine can run.
 */
import { z } from "zod";
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_RULE_STATUSES,
  AUTOMATION_RUN_STATUSES,
  LEDGER_ACTIONS,
  NOTIFICATION_KINDS,
  SIGNAL_SEVERITIES,
} from "@constructos/shared";
import { pageQuerySchema } from "../../lib/pagination.js";
import { validateCondition } from "./predicates.js";
import { snapshotEntry } from "./snapshots.js";

const objectTypeName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^(\*|[a-z][a-z0-9_]*)$/, 'objectType must be snake_case or "*"');

export const triggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("event"),
    objectType: objectTypeName,
    action: z.enum([...LEDGER_ACTIONS, "*"]).default("*"),
  }),
  z
    .object({
      kind: z.literal("schedule"),
      objectType: objectTypeName,
      everyMinutes: z.coerce.number().int().min(5).max(10_080).default(60),
      cooldownHours: z.coerce.number().int().min(1).max(720).default(24),
    })
    .refine((t) => t.objectType !== "*" && snapshotEntry(t.objectType) !== undefined, {
      message: "schedule triggers need a record type the platform can scan (see GET /automation/catalogue)",
      path: ["objectType"],
    }),
]);

export const conditionSchema = z.unknown().superRefine((v, ctx) => {
  if (v === null || v === undefined) return;
  const err = validateCondition(v);
  if (err) ctx.addIssue({ code: "custom", message: err });
});

const notifyTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("users"), userIds: z.array(z.string().min(1).max(64)).min(1).max(100) }),
  z.object({ kind: z.literal("roles"), roles: z.array(z.string().min(1).max(40)).min(1).max(10) }),
  z.object({ kind: z.literal("distribution_groups"), groupIds: z.array(z.string().min(1).max(64)).min(1).max(50) }),
  z.object({ kind: z.literal("project_members") }),
  z.object({ kind: z.literal("record_field"), field: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.]+$/) }),
]);

const shortText = z.string().max(500);
const longText = z.string().max(4000);

const notifyParams = z.object({
  to: z.array(notifyTargetSchema).min(1).max(20),
  kind: z.enum(NOTIFICATION_KINDS).optional(),
  title: shortText.optional(),
  body: longText.optional(),
});

const escalateParams = z.object({
  to: z.array(notifyTargetSchema).max(20).optional(),
  title: shortText.optional(),
  body: longText.optional(),
  raiseSignal: z.boolean().optional(),
  severity: z.enum(SIGNAL_SEVERITIES).optional(),
  reassignTo: z.string().min(1).max(64).optional(),
});

const obligationParams = z
  .object({
    sourceClause: shortText.optional(),
    trigger: shortText.optional(),
    deadline: z.string().max(40).optional(),
    deadlineField: z.string().max(120).regex(/^[A-Za-z0-9_.]+$/).optional(),
    dueInDays: z.coerce.number().int().min(0).max(3650).optional(),
    warnDaysBefore: z.coerce.number().min(0).max(365).optional(),
    evidenceRequirement: shortText.optional(),
    obligorId: z.string().max(64).optional(),
    obligeeId: z.string().max(64).optional(),
  })
  .refine((p) => p.deadline !== undefined || p.deadlineField !== undefined || p.dueInDays !== undefined, {
    message: "create_obligation needs deadline, deadlineField or dueInDays",
  });

const signalParams = z.object({
  detector: z.string().min(1).max(120).regex(/^[a-z][a-z0-9_.]*$/),
  severity: z.enum(SIGNAL_SEVERITIES).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  title: shortText.optional(),
  explanation: longText.optional(),
});

const webhookParams = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    }, "url must be an absolute http(s) URL"),
  includeRecord: z.boolean().optional(),
  secret: z.string().min(8).max(200).optional(),
  headers: z.record(z.string().max(64), z.string().max(500)).optional(),
});

const runAgentParams = z.object({
  agentKind: z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/),
  summary: shortText.optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const assignParams = z
  .object({
    userId: z.string().min(1).max(64).optional(),
    userField: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.]+$/).optional(),
    notify: z.boolean().optional(),
  })
  .refine((p) => p.userId !== undefined || p.userField !== undefined, {
    message: "assign needs userId or userField",
  });

const tagParams = z.object({
  name: z.string().min(1).max(80),
  color: z.string().max(20).optional(),
});

const taskParams = z.object({
  title: shortText.optional(),
  description: longText.optional(),
  ownerId: z.string().max(64).optional(),
  ownerField: z.string().max(120).regex(/^[A-Za-z0-9_.]+$/).optional(),
  dueInDays: z.coerce.number().int().min(0).max(3650).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
});

const PARAM_SCHEMAS: Record<(typeof AUTOMATION_ACTION_TYPES)[number], z.ZodTypeAny> = {
  notify: notifyParams,
  escalate: escalateParams,
  create_obligation: obligationParams,
  create_signal: signalParams,
  webhook: webhookParams,
  run_agent: runAgentParams,
  assign: assignParams,
  tag: tagParams,
  create_task: taskParams,
};

/**
 * Validate one action's params against its type. Returns the parsed params
 * or the list of problems — never throws, so the caller (a zod transform)
 * can attach the problems to the request's own issue list at the right path.
 */
export function parseActionParams(
  type: string,
  params: unknown,
): { ok: true; params: Record<string, unknown> } | { ok: false; issues: Array<{ path: PropertyKey[]; message: string }> } {
  const schema = PARAM_SCHEMAS[type as (typeof AUTOMATION_ACTION_TYPES)[number]];
  if (!schema) return { ok: false, issues: [{ path: ["type"], message: `unknown action type "${type}"` }] };
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: ["params", ...i.path], message: i.message })) };
  }
  return { ok: true, params: parsed.data as Record<string, unknown> };
}

export const actionSchema = z
  .object({
    type: z.enum(AUTOMATION_ACTION_TYPES),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .transform((a, ctx) => {
    const result = parseActionParams(a.type, a.params);
    if (!result.ok) {
      for (const issue of result.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
      return z.NEVER;
    }
    return { type: a.type, params: result.params };
  });

export const ruleBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  projectId: z.string().min(1).max(64).nullable().optional(),
  status: z.enum(AUTOMATION_RULE_STATUSES).optional(),
  trigger: triggerSchema,
  conditions: conditionSchema.optional(),
  actions: z.array(actionSchema).min(1).max(10),
  immediate: z.boolean().optional(),
  priority: z.coerce.number().int().min(0).max(1000).optional(),
});

export const rulePatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    trigger: triggerSchema.optional(),
    conditions: conditionSchema.optional(),
    actions: z.array(actionSchema).min(1).max(10).optional(),
    immediate: z.boolean().optional(),
    priority: z.coerce.number().int().min(0).max(1000).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "no fields to update");

export const rulesQuerySchema = pageQuerySchema.extend({
  status: z.enum(AUTOMATION_RULE_STATUSES).optional(),
  projectId: z.string().max(64).optional(),
  objectType: z.string().max(80).optional(),
  triggerKind: z.enum(["event", "schedule"]).optional(),
  search: z.string().max(200).optional(),
});

export const runsQuerySchema = pageQuerySchema.extend({
  ruleId: z.string().max(64).optional(),
  status: z.enum(AUTOMATION_RUN_STATUSES).optional(),
  projectId: z.string().max(64).optional(),
  objectType: z.string().max(80).optional(),
  objectId: z.string().max(64).optional(),
});

export const testBodySchema = z.object({
  objectId: z.string().min(1).max(64).optional(),
  record: z.record(z.string(), z.unknown()).optional(),
  event: z.object({ action: z.enum(LEDGER_ACTIONS).optional(), actorId: z.string().max(64).nullable().optional() }).optional(),
  persist: z.boolean().optional(),
});

export const unsavedTestBodySchema = testBodySchema.extend({ rule: ruleBodySchema });

export const instantiateBodySchema = z.object({
  projectId: z.string().min(1).max(64).nullable().optional(),
  name: z.string().min(1).max(200).optional(),
  status: z.enum(["draft", "active"]).optional(),
  immediate: z.boolean().optional(),
  /** replace one action's params by index, e.g. the webhook url */
  actionOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export const runCycleBodySchema = z
  .object({ drain: z.boolean().optional(), scan: z.boolean().optional(), force: z.boolean().optional() })
  .optional()
  .default({});
