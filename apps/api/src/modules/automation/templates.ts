/**
 * Rule template library (Vol I #79–92, #85–86; Vol II X #1005–1009).
 *
 * Code-resident, versioned with the platform, instantiated into a tenant's
 * own `automation_rules` row (which the tenant then owns and may edit). A
 * template is a complete, valid rule: trigger + conditions + actions, with
 * the same shapes the builder produces, so "instantiate" is a copy with the
 * tenant's project and any overrides applied — never a special code path.
 *
 * Every template states what it does NOT do where that matters: none of them
 * changes a financial status directly (an invoice hold is an escalation plus
 * a signal, the hold itself stays a human decision through the invoicing
 * module's own transition route — segregation of duties, plan §6.3).
 */
import type {
  AutomationActionJson,
  AutomationConditionJson,
  AutomationTriggerJson,
} from "@constructos/db";
import type { AutomationTemplateCategory } from "@constructos/shared";

export interface RuleTemplate {
  key: string;
  name: string;
  description: string;
  category: AutomationTemplateCategory;
  /** spec references this template serves */
  spec: string[];
  trigger: AutomationTriggerJson;
  conditions: AutomationConditionJson | null;
  actions: AutomationActionJson[];
  immediate: boolean;
  /** what a tenant will usually want to tune */
  tunables: string[];
}

const ESCALATE_TO_ADMINS = (title: string, body: string): AutomationActionJson => ({
  type: "escalate",
  params: {
    to: [{ kind: "roles", roles: ["owner", "admin"] }],
    title,
    body,
    raiseSignal: false,
  },
});

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    key: "rfi_overdue_escalate",
    name: "RFI overdue 3 days → escalate to project admins",
    description:
      "Scans open RFIs every hour. When one is at least 3 days past its due date, the ball-in-court " +
      "holder is notified and the project's admins are escalated to. Fires once per RFI per day.",
    category: "field",
    spec: ["#85", "#86", "#321"],
    trigger: { kind: "schedule", objectType: "rfi", everyMinutes: 60, cooldownHours: 24 },
    conditions: {
      all: [
        { field: "record.status", op: "eq", value: "open" },
        { field: "record.dueDate", op: "overdue_by_days", value: 3 },
      ],
    },
    actions: [
      {
        type: "notify",
        params: {
          to: [{ kind: "record_field", field: "ballInCourtId" }],
          kind: "overdue",
          title: "RFI {{record.number}} is overdue: {{record.subject}}",
          body: "Due {{record.dueDate}}; still open. Please respond or reassign.",
        },
      },
      ESCALATE_TO_ADMINS(
        "Overdue RFI {{record.number}}: {{record.subject}}",
        "RFI has been overdue for at least 3 days (due {{record.dueDate}}).",
      ),
    ],
    immediate: false,
    tunables: ["overdue_by_days (3)", "everyMinutes (60)", "cooldownHours (24)"],
  },
  {
    key: "invoice_submitted_expired_insurance",
    name: "Invoice submitted with expired vendor insurance → hold review",
    description:
      "When an invoice is submitted or moves state, checks the vendor's insurance certificates. If the " +
      "vendor has no certificate valid today, a compliance signal is raised, the approvers are escalated " +
      "to, and the invoice is tagged 'insurance-hold'. The hold itself stays a human decision in Invoicing.",
    category: "financial",
    spec: ["#575", "#530"],
    trigger: { kind: "event", objectType: "invoice", action: "state_change" },
    conditions: {
      all: [
        { field: "record.status", op: "in", value: ["submitted", "under_review"] },
        { field: "record.vendorId", op: "exists" },
        { field: "derived.vendorInsuranceValid", op: "is_false" },
      ],
    },
    actions: [
      {
        type: "create_signal",
        params: {
          detector: "automation.invoice_vendor_insurance_expired",
          severity: "high",
          confidence: 0.9,
          title: "Invoice {{record.reference}} submitted by a vendor without valid insurance",
          explanation:
            "No insurance certificate for vendor {{record.vendorId}} is valid today. Payment should be held until cover is evidenced.",
        },
      },
      { type: "tag", params: { name: "insurance-hold" } },
      ESCALATE_TO_ADMINS(
        "Insurance hold recommended: invoice {{record.reference}}",
        "The vendor has no insurance certificate valid today. Review before approval.",
      ),
    ],
    immediate: true,
    tunables: ["severity (high)", "tag name (insurance-hold)"],
  },
  {
    key: "signal_critical_notify_reviewer",
    name: "Critical signal → notify integrity reviewers",
    description:
      "When a detector raises a critical signal, every holder of the integrity_reviewer assurance role " +
      "is notified immediately, and the company owners are copied.",
    category: "assurance",
    spec: ["#1005", "#1011"],
    trigger: { kind: "event", objectType: "signal", action: "create" },
    conditions: { all: [{ field: "record.severity", op: "eq", value: "critical" }] },
    actions: [
      {
        type: "notify",
        params: {
          to: [
            { kind: "roles", roles: ["owner"] },
            { kind: "roles", roles: ["integrity_reviewer"] },
          ],
          kind: "signal",
          title: "Critical signal: {{record.title}}",
          body: "{{record.explanation}}",
        },
      },
    ],
    immediate: true,
    tunables: ["severity (critical)", "recipients"],
  },
  {
    key: "time_bar_5_days_draft_notice",
    name: "Time bar 5 days out → draft notice",
    description:
      "Scans open contract events every 6 hours. When a notice deadline is within 5 days and no notice has " +
      "been served, the event raiser is notified, an obligation is recorded against the deadline, and a " +
      "time-bar notice draft is requested from the AI agent fleet (queued for human review).",
    category: "contract",
    spec: ["#1006", "#1007", "#1008"],
    trigger: { kind: "schedule", objectType: "contract_event", everyMinutes: 360, cooldownHours: 48 },
    conditions: {
      all: [
        { field: "record.status", op: "eq", value: "open" },
        { field: "record.noticeServedAt", op: "not_exists" },
        { field: "record.noticeDeadline", op: "due_within_days", value: 5 },
      ],
    },
    actions: [
      {
        type: "notify",
        params: {
          to: [{ kind: "record_field", field: "raisedBy" }, { kind: "roles", roles: ["owner", "admin"] }],
          kind: "due_soon",
          title: "Time bar in ≤5 days: {{record.title}}",
          body: "Notice deadline {{record.noticeDeadline}} under clause {{record.clauseRef}}. Serve notice or lose the entitlement.",
        },
      },
      {
        type: "create_obligation",
        params: {
          sourceClause: "{{record.clauseRef}}",
          trigger: "Serve notice for contract event {{record.number}}: {{record.title}}",
          deadlineField: "noticeDeadline",
          warnDaysBefore: 5,
          evidenceRequirement: "Served notice with proof of delivery",
        },
      },
      {
        type: "run_agent",
        params: {
          agentKind: "time_bar_notice_drafter",
          summary: "Draft time-bar notice for contract event {{record.number}} ({{record.title}})",
        },
      },
    ],
    immediate: false,
    tunables: ["due_within_days (5)", "everyMinutes (360)"],
  },
  {
    key: "submittal_at_risk",
    name: "Submittal required on site within 14 days and still open → flag",
    description:
      "Scans open submittals every 12 hours. When the required-on-site date is within 14 days and the " +
      "submittal is not yet responded, the ball-in-court holder is notified and the item is tagged at-risk.",
    category: "field",
    spec: ["#339"],
    trigger: { kind: "schedule", objectType: "submittal", everyMinutes: 720, cooldownHours: 72 },
    conditions: {
      all: [
        { field: "record.status", op: "in", value: ["draft", "open", "in_review"] },
        { field: "record.requiredOnSite", op: "due_within_days", value: 14 },
      ],
    },
    actions: [
      {
        type: "notify",
        params: {
          to: [{ kind: "record_field", field: "ballInCourtId" }, { kind: "record_field", field: "createdBy" }],
          kind: "due_soon",
          title: "Submittal {{record.number}} at risk: required on site {{record.requiredOnSite}}",
          body: "Still {{record.status}}. Turnaround must complete before the required-on-site date.",
        },
      },
      { type: "tag", params: { name: "at-risk" } },
    ],
    immediate: false,
    tunables: ["due_within_days (14)"],
  },
  {
    key: "incident_reportable_regulator_clock",
    name: "Reportable incident → notify safety leads and record the regulator deadline",
    description:
      "When a safety incident is created or changes state and is marked reportable, company admins are " +
      "escalated to immediately and an obligation is recorded against the regulator report deadline.",
    category: "safety",
    spec: ["#647", "#655"],
    trigger: { kind: "event", objectType: "safety_incident", action: "*" },
    conditions: {
      all: [
        { field: "record.isReportable", op: "is_true" },
        { field: "record.regulatorNotifiedAt", op: "not_exists" },
      ],
    },
    actions: [
      ESCALATE_TO_ADMINS(
        "Reportable incident {{record.reference}}: {{record.title}}",
        "Regulator report due {{record.reportDueAt}}. Not yet notified.",
      ),
      {
        type: "create_obligation",
        params: {
          sourceClause: "Statutory incident reporting",
          trigger: "Notify regulator of incident {{record.reference}}",
          deadlineField: "reportDueAt",
          warnDaysBefore: 1,
          evidenceRequirement: "Regulator reference and submission receipt",
        },
      },
    ],
    immediate: true,
    tunables: ["recipients"],
  },
  {
    key: "ncr_major_backcharge_review",
    name: "Major NCR against a vendor → assign review and tag for backcharge",
    description:
      "When a major or critical non-conformance is raised against a vendor, admins are escalated to and " +
      "the NCR is tagged for backcharge review. A change event is NOT created automatically.",
    category: "quality",
    spec: ["#1091", "#1098"],
    trigger: { kind: "event", objectType: "non_conformance_report", action: "create" },
    conditions: {
      all: [
        { field: "record.severity", op: "in", value: ["major", "critical"] },
        { field: "record.raisedAgainstVendorId", op: "exists" },
      ],
    },
    actions: [
      { type: "tag", params: { name: "backcharge-review" } },
      ESCALATE_TO_ADMINS(
        "Major NCR {{record.reference}} against a vendor",
        "{{record.title}} — consider backcharge and vendor performance impact.",
      ),
    ],
    immediate: true,
    tunables: ["severity list"],
  },
  {
    key: "certificate_expiring_30_days",
    name: "Insurance certificate expires within 30 days → chase",
    description:
      "Scans active certificates daily. When one expires within 30 days, admins are notified and an " +
      "obligation to obtain a renewed certificate is recorded.",
    category: "compliance",
    spec: ["#780", "#519"],
    trigger: { kind: "schedule", objectType: "insurance_certificate", everyMinutes: 1440, cooldownHours: 168 },
    conditions: {
      all: [
        { field: "record.status", op: "eq", value: "active" },
        { field: "record.validTo", op: "due_within_days", value: 30 },
      ],
    },
    actions: [
      {
        type: "notify",
        params: {
          to: [{ kind: "roles", roles: ["owner", "admin"] }],
          kind: "compliance",
          title: "Certificate for {{record.subjectName}} expires {{record.validTo}}",
          body: "{{record.policyType}} — request a renewed certificate before expiry.",
        },
      },
      {
        type: "create_obligation",
        params: {
          sourceClause: "Insurance requirement",
          trigger: "Obtain renewed {{record.policyType}} certificate for {{record.subjectName}}",
          deadlineField: "validTo",
          warnDaysBefore: 14,
          evidenceRequirement: "Renewed certificate on file and verified",
        },
      },
    ],
    immediate: false,
    tunables: ["due_within_days (30)", "cooldownHours (168)"],
  },
  {
    key: "obligation_breached_escalate",
    name: "Obligation breached → escalate",
    description:
      "When an obligation's status changes to breached, company owners and admins are escalated to and " +
      "a high-severity signal records the breach for the assurance layer.",
    category: "assurance",
    spec: ["#1008", "#1009"],
    trigger: { kind: "event", objectType: "obligation", action: "state_change" },
    conditions: { all: [{ field: "record.status", op: "eq", value: "breached" }] },
    actions: [
      {
        type: "create_signal",
        params: {
          detector: "automation.obligation_breached",
          severity: "high",
          confidence: 0.95,
          title: "Obligation breached: {{record.trigger}}",
          explanation: "Deadline {{record.deadline}} passed without satisfying evidence (clause {{record.sourceClause}}).",
        },
      },
      ESCALATE_TO_ADMINS("Obligation breached: {{record.trigger}}", "Clause {{record.sourceClause}}."),
    ],
    immediate: true,
    tunables: ["severity"],
  },
  {
    key: "change_event_stale_14_days",
    name: "Change event open 14+ days with no decision → chase",
    description:
      "Scans open change events daily. When one has been open for 14 days or more, the creator and admins " +
      "are notified. Fires once a week per event while it stays open.",
    category: "financial",
    spec: ["#560", "#561"],
    trigger: { kind: "schedule", objectType: "change_event", everyMinutes: 1440, cooldownHours: 168 },
    conditions: {
      all: [
        { field: "record.status", op: "in", value: ["open", "pending"] },
        { field: "record.createdAt", op: "older_than_days", value: 14 },
      ],
    },
    actions: [
      {
        type: "notify",
        params: {
          to: [{ kind: "record_field", field: "createdBy" }, { kind: "roles", roles: ["admin"] }],
          kind: "reminder",
          title: "Change event {{record.reference}} open for 14+ days",
          body: "{{record.title}} — latest cost {{record.latestCost}}. Progress it or close it.",
        },
      },
    ],
    immediate: false,
    tunables: ["older_than_days (14)", "cooldownHours (168)"],
  },
  {
    key: "action_item_overdue_task",
    name: "Action item overdue → create follow-up task for the owner",
    description:
      "Scans open meeting action items every 12 hours. When one is at least 2 days overdue, a follow-up " +
      "task is created for its owner and the owner is notified.",
    category: "field",
    spec: ["#86", "#456"],
    trigger: { kind: "schedule", objectType: "meeting_action_item", everyMinutes: 720, cooldownHours: 96 },
    conditions: {
      all: [
        { field: "record.status", op: "in", value: ["open", "in_progress", "blocked"] },
        { field: "record.dueDate", op: "overdue_by_days", value: 2 },
      ],
    },
    actions: [
      {
        type: "create_task",
        params: {
          title: "Follow up overdue action {{record.reference}}: {{record.title}}",
          description: "Original due date {{record.dueDate}}. Close out or revise with a reason.",
          ownerField: "ownerId",
          dueInDays: 3,
          priority: "high",
        },
      },
      {
        type: "notify",
        params: {
          to: [{ kind: "record_field", field: "ownerId" }],
          kind: "overdue",
          title: "Action {{record.reference}} is overdue",
          body: "{{record.title}} was due {{record.dueDate}}.",
        },
      },
    ],
    immediate: false,
    tunables: ["overdue_by_days (2)", "dueInDays (3)"],
  },
  {
    key: "permit_expiring_notify_owner",
    name: "Permit expires within 21 days → notify owner",
    description:
      "Scans live permits daily. When one expires within 21 days, its owner and the admins are notified.",
    category: "compliance",
    spec: ["#1076"],
    trigger: { kind: "schedule", objectType: "permit", everyMinutes: 1440, cooldownHours: 168 },
    conditions: {
      all: [
        { field: "record.status", op: "eq", value: "granted" },
        { field: "record.expiresAt", op: "due_within_days", value: 21 },
      ],
    },
    actions: [
      {
        type: "notify",
        params: {
          to: [{ kind: "record_field", field: "ownerId" }, { kind: "roles", roles: ["admin"] }],
          kind: "due_soon",
          title: "Permit {{record.title}} expires {{record.expiresAt}}",
          body: "Authority: {{record.authority}}. Renew or record the consequence.",
        },
      },
    ],
    immediate: false,
    tunables: ["due_within_days (21)"],
  },
  {
    key: "high_value_invoice_webhook",
    name: "Invoice approved above a threshold → call an external endpoint",
    description:
      "When an invoice moves to approved with a total above the threshold, POSTs a signed JSON envelope " +
      "to an endpoint you nominate (set the URL and threshold after instantiating).",
    category: "financial",
    spec: ["#121", "#582"],
    trigger: { kind: "event", objectType: "invoice", action: "state_change" },
    conditions: {
      all: [
        { field: "record.status", op: "in", value: ["approved", "approved_as_noted"] },
        { field: "record.total", op: "gte", value: 100000 },
      ],
    },
    actions: [
      {
        type: "webhook",
        params: {
          url: "https://example.invalid/replace-me",
          includeRecord: true,
        },
      },
    ],
    immediate: false,
    tunables: ["url", "threshold (100000)"],
  },
];

const BY_KEY = new Map(RULE_TEMPLATES.map((t) => [t.key, t]));

export function ruleTemplate(key: string): RuleTemplate | undefined {
  return BY_KEY.get(key);
}
