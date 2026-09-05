/**
 * COMPANY SECURITY — the workspace an owner or administrator opens to govern
 * how their people authenticate, and to see what actually happened.
 *
 * Five surfaces, each one backed by a control the API enforces rather than
 * suggests (Vol I §0.1 #21, #23, #24, #25 and §0.2):
 *
 *   Policy      session timeouts, password rules, lockout thresholds and the
 *               IP allowlist. Every field shows the platform default beside
 *               it, so "we have not chosen" is visibly different from "we
 *               chose the same number".
 *   Activity    the login audit, filterable, with a CSV/JSON export. It says
 *               out loud what it CANNOT show — attempts against an address
 *               that belongs to nobody carry no company and are the
 *               operator's, not a tenant's.
 *   People      deactivate, cut every session, clear a lost second factor.
 *   Directory   SCIM 2.0 bearer tokens, shown exactly once.
 *   Webhooks    push the security trail to a SIEM, with the delivery log —
 *               including the deliveries that failed.
 *
 * THE HONESTY RULES THIS PAGE KEEPS. A figure the API did not return renders
 * as "—" with a reason, never as 0: MFA coverage for a company with no members
 * is not "0%", it is "not available — this company has no members". Every
 * panel loads, fails and empties on its own.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  Stat,
  StatusPill,
  Tabs,
  Textarea,
  formatNumber,
  type DataColumns,
} from "../../ui";
import {
  IconActivity,
  IconCompliance,
  IconGlobe,
  IconLock,
  IconSecurity,
  IconSend,
  IconTrash,
  IconUsers,
} from "../../ui/icons";
import { api } from "../../lib/api";
import { FailureAlert, Reasons, ShowOnce, useAuthAction } from "./authShared";

/* ================================================================== */
/* Wire shapes                                                         */
/* ================================================================== */

interface StoredPolicy {
  companyId: string;
  sessionIdleTimeoutMinutes: number | null;
  sessionAbsoluteTimeoutHours: number | null;
  rememberDeviceDays: number | null;
  passwordMinLength: number | null;
  passwordRequireComplexity: boolean;
  passwordHistoryDepth: number | null;
  passwordMaxAgeDays: number | null;
  lockoutMaxAttempts: number | null;
  lockoutWindowMinutes: number | null;
  lockoutDurationMinutes: number | null;
  ipAllowlistMode: "off" | "monitor" | "enforce";
  ipAllowlist: string[];
  ipAllowlistBreakGlassUserIds: string[];
  mfaRequired: boolean;
  mfaAcceptedAmrValues: string[];
  securityEventRetentionDays: number | null;
  emailDispatchRetentionDays: number | null;
  legalHold: boolean;
  legalHoldReason: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface ResolvedPolicy {
  sessionIdleTimeoutMinutes: number | null;
  sessionAbsoluteTimeoutHours: number;
  rememberDeviceDays: number;
  passwordMinLength: number;
  passwordRequireComplexity: boolean;
  passwordHistoryDepth: number;
  passwordMaxAgeDays: number | null;
  lockoutMaxAttempts: number;
  lockoutWindowMinutes: number;
  lockoutDurationMinutes: number;
  mfaRequired: boolean;
  sources: string[];
}

interface PolicyResponse {
  companyId: string;
  companyName: string | null;
  stored: StoredPolicy;
  effective: ResolvedPolicy;
  defaults: Record<string, unknown>;
  passwordRules: string[];
  reasons: string[];
}

interface RetentionOutcome {
  companyId: string;
  skipped: boolean;
  reason: string | null;
  securityEventsPseudonymised: number;
  emailDispatchesDeleted: number;
  reasons: string[];
}

interface HealthInputs {
  metrics: {
    members: number;
    mfaEnrolled: number;
    mfaCoveragePercent: number | null;
    failedSignIns24h: number;
    blockedSignIns24h: number;
    policyConfigured: number;
    ipAllowlistEnforced: number;
    mfaRequired: number;
  };
  reasons: string[];
}

interface AuditEvent {
  id: string;
  at: string;
  kind: string;
  outcome: string;
  userId: string | null;
  email: string | null;
  sessionId: string | null;
  providerId: string | null;
  ip: string | null;
  userAgent: string | null;
  reason: string | null;
}

interface AuditResponse {
  items: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  reasons: string[];
}

interface Member {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
}

interface ScimToken {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  useCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  status: string;
}

interface Webhook {
  id: string;
  name: string;
  url: string;
  eventKinds: string[];
  isEnabled: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  lastDeliveryAt: string | null;
  lastStatus: string | null;
  secretFingerprint: string | null;
  createdAt: string;
}

interface Delivery {
  id: string;
  webhookId: string;
  eventKind: string;
  status: string;
  statusCode: number | null;
  attempts: number;
  error: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

/* ================================================================== */
/* Small shared helpers                                                */
/* ================================================================== */

/** A value the API did not give us is "—" with a reason, never 0. */
function orDash(value: number | null | undefined, suffix = ""): string {
  return value === null || value === undefined ? "—" : `${value}${suffix}`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString();
}

function useJson<T>(path: string, nonce: number, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    api
      .get<T>(path)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load this panel.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, nonce, enabled]);
  return { data, loading, error };
}

const TABS = [
  { id: "policy", label: "Policy" },
  { id: "activity", label: "Sign-in activity" },
  { id: "people", label: "People" },
  { id: "directory", label: "Directory (SCIM)" },
  { id: "webhooks", label: "Event webhooks" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/* ================================================================== */

export default function SecurityPage() {
  const [tab, setTab] = useState<TabId>("policy");
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const policy = useJson<PolicyResponse>("/api/v1/company/security-policy", nonce);
  const health = useJson<HealthInputs>("/api/v1/company/security/health-inputs", nonce);

  const metrics = health.data?.metrics;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Security"
        subtitle={
          policy.data?.companyName
            ? `Authentication policy, audit and provisioning for ${policy.data.companyName}`
            : "Authentication policy, audit and provisioning"
        }
        icon={IconSecurity}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Second-factor coverage"
          value={orDash(metrics?.mfaCoveragePercent, "%")}
          hint={
            metrics
              ? metrics.mfaCoveragePercent === null
                ? "Not available — this company has no members to count."
                : `${metrics.mfaEnrolled} of ${metrics.members} members have a confirmed factor.`
              : "Loading…"
          }
        />
        <Stat
          label="Failed sign-ins (24h)"
          value={orDash(metrics?.failedSignIns24h)}
          hint="Wrong password, or an address with no account."
        />
        <Stat
          label="Refused by policy (24h)"
          value={orDash(metrics?.blockedSignIns24h)}
          hint="Lockout, a deactivated account, an address outside the allowlist."
        />
        <Stat
          label="Policy"
          value={
            policy.data ? (policy.data.stored.updatedAt ? "Configured" : "Defaults") : "—"
          }
          hint={
            policy.data?.stored.updatedAt
              ? `Last changed ${when(policy.data.stored.updatedAt)}.`
              : "Nobody has set a policy, so the platform defaults apply."
          }
        />
      </div>

      <Tabs
        items={TABS.map((t) => ({ value: t.id, label: t.label }))}
        value={tab}
        onChange={(id) => setTab(id as TabId)}
        aria-label="Company security"
      />

      {tab === "policy" ? (
        <PolicyTab policy={policy} onSaved={refresh} />
      ) : tab === "activity" ? (
        <ActivityTab />
      ) : tab === "people" ? (
        <PeopleTab nonce={nonce} onChanged={refresh} />
      ) : tab === "directory" ? (
        <DirectoryTab nonce={nonce} onChanged={refresh} />
      ) : (
        <WebhooksTab nonce={nonce} onChanged={refresh} />
      )}
    </div>
  );
}

/* ================================================================== */
/* Policy                                                              */
/* ================================================================== */

interface PolicyForm {
  sessionIdleTimeoutMinutes: string;
  sessionAbsoluteTimeoutHours: string;
  passwordMinLength: string;
  passwordRequireComplexity: boolean;
  passwordHistoryDepth: string;
  passwordMaxAgeDays: string;
  lockoutMaxAttempts: string;
  lockoutWindowMinutes: string;
  lockoutDurationMinutes: string;
  ipAllowlistMode: "off" | "monitor" | "enforce";
  ipAllowlist: string;
  mfaRequired: boolean;
  securityEventRetentionDays: string;
  emailDispatchRetentionDays: string;
  legalHold: boolean;
  legalHoldReason: string;
}

function formFrom(stored: StoredPolicy): PolicyForm {
  const num = (v: number | null) => (v === null ? "" : String(v));
  return {
    sessionIdleTimeoutMinutes: num(stored.sessionIdleTimeoutMinutes),
    sessionAbsoluteTimeoutHours: num(stored.sessionAbsoluteTimeoutHours),
    passwordMinLength: num(stored.passwordMinLength),
    passwordRequireComplexity: stored.passwordRequireComplexity,
    passwordHistoryDepth: num(stored.passwordHistoryDepth),
    passwordMaxAgeDays: num(stored.passwordMaxAgeDays),
    lockoutMaxAttempts: num(stored.lockoutMaxAttempts),
    lockoutWindowMinutes: num(stored.lockoutWindowMinutes),
    lockoutDurationMinutes: num(stored.lockoutDurationMinutes),
    ipAllowlistMode: stored.ipAllowlistMode,
    ipAllowlist: stored.ipAllowlist.join("\n"),
    mfaRequired: stored.mfaRequired,
    securityEventRetentionDays: num(stored.securityEventRetentionDays),
    emailDispatchRetentionDays: num(stored.emailDispatchRetentionDays),
    legalHold: stored.legalHold,
    legalHoldReason: stored.legalHoldReason ?? "",
  };
}

/** "" means "leave it to the platform", which is not the same as 0. */
function numberOrNull(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function PolicyTab({
  policy,
  onSaved,
}: {
  policy: { data: PolicyResponse | null; loading: boolean; error: string | null };
  onSaved: () => void;
}) {
  const action = useAuthAction();
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (policy.data) setForm(formFrom(policy.data.stored));
  }, [policy.data]);

  if (policy.error) return <ErrorAlert message={policy.error} />;
  if (!policy.data || !form) return <Skeleton height={420} radius="lg" />;

  const effective = policy.data.effective;

  async function save() {
    if (!form) return;
    const res = await action.run("policy", () =>
      api.put<PolicyResponse>("/api/v1/company/security-policy", {
        sessionIdleTimeoutMinutes: numberOrNull(form.sessionIdleTimeoutMinutes),
        sessionAbsoluteTimeoutHours: numberOrNull(form.sessionAbsoluteTimeoutHours),
        passwordMinLength: numberOrNull(form.passwordMinLength),
        passwordRequireComplexity: form.passwordRequireComplexity,
        passwordHistoryDepth: numberOrNull(form.passwordHistoryDepth),
        passwordMaxAgeDays: numberOrNull(form.passwordMaxAgeDays),
        lockoutMaxAttempts: numberOrNull(form.lockoutMaxAttempts),
        lockoutWindowMinutes: numberOrNull(form.lockoutWindowMinutes),
        lockoutDurationMinutes: numberOrNull(form.lockoutDurationMinutes),
        ipAllowlistMode: form.ipAllowlistMode,
        ipAllowlist: form.ipAllowlist
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
        mfaRequired: form.mfaRequired,
        securityEventRetentionDays: numberOrNull(form.securityEventRetentionDays),
        emailDispatchRetentionDays: numberOrNull(form.emailDispatchRetentionDays),
        legalHold: form.legalHold,
        legalHoldReason: form.legalHoldReason.trim() === "" ? null : form.legalHoldReason.trim(),
      }),
    );
    if (res) {
      setSaved(true);
      onSaved();
    }
  }

  const set = <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };

  return (
    <div className="space-y-4">
      <FailureAlert failure={action.failure} onDismiss={action.clear} />
      {saved ? (
        <Alert tone="success" size="sm" title="Policy saved">
          It applies to the next sign-in and the next password change. Existing sessions keep the
          lifetime they were opened with.
        </Alert>
      ) : null}
      {policy.data.reasons.length > 0 ? <Reasons reasons={policy.data.reasons} /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Sessions" subtitle="Spec #23 — how long a device stays signed in" />
          <CardBody className="space-y-3">
            <Field
              label="Idle timeout (minutes)"
              hint={`Blank = no idle timeout, which is the platform default. Last-seen is refreshed at most once a minute, so anything under five minutes is refused.`}
            >
              <Input
                inputMode="numeric"
                placeholder="no idle timeout"
                value={form.sessionIdleTimeoutMinutes}
                onChange={(e) => set("sessionIdleTimeoutMinutes", e.target.value)}
              />
            </Field>
            <Field
              label="Absolute lifetime (hours)"
              hint={`Blank = the platform default of ${effective.sessionAbsoluteTimeoutHours} hours. A session is ended at this age however active it has been.`}
            >
              <Input
                inputMode="numeric"
                placeholder={String(effective.sessionAbsoluteTimeoutHours)}
                value={form.sessionAbsoluteTimeoutHours}
                onChange={(e) => set("sessionAbsoluteTimeoutHours", e.target.value)}
              />
            </Field>
            <label className="flex items-start gap-2 text-meta">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.mfaRequired}
                onChange={(e) => set("mfaRequired", e.target.checked)}
              />
              <span>
                Require a second factor.
                <span className="block text-2xs text-content-subtle">
                  Members without one are asked to enrol at their next sign-in. SSO sessions are
                  challenged too unless the connection is configured to perform MFA itself.
                </span>
              </span>
            </label>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Passwords" subtitle="Spec #25 — what a password must clear" />
          <CardBody className="space-y-3">
            <Field
              label="Minimum length"
              hint="The platform floor is 12 and cannot be lowered, only raised."
            >
              <Input
                inputMode="numeric"
                placeholder="12"
                value={form.passwordMinLength}
                onChange={(e) => set("passwordMinLength", e.target.value)}
              />
            </Field>
            <label className="flex items-start gap-2 text-meta">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.passwordRequireComplexity}
                onChange={(e) => set("passwordRequireComplexity", e.target.checked)}
              />
              <span>
                Require upper case, lower case, a digit and a symbol.
                <span className="block text-2xs text-content-subtle">
                  Length buys more entropy than character classes; this is here because auditors
                  ask for it, not because it is the stronger control.
                </span>
              </span>
            </label>
            <Field
              label="Refuse the last N passwords"
              hint="Blank or 0 = reuse is not checked. Each retained hash costs one bcrypt comparison on every change; the ceiling is 24."
            >
              <Input
                inputMode="numeric"
                placeholder="0"
                value={form.passwordHistoryDepth}
                onChange={(e) => set("passwordHistoryDepth", e.target.value)}
              />
            </Field>
            <Field label="Maximum age (days)" hint="Blank = passwords do not expire.">
              <Input
                inputMode="numeric"
                placeholder="no expiry"
                value={form.passwordMaxAgeDays}
                onChange={(e) => set("passwordMaxAgeDays", e.target.value)}
              />
            </Field>
            <div className="rounded-lg border border-border bg-surface-sunken p-2">
              <p className="text-label uppercase text-content-subtle">In force right now</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-2xs text-content-muted">
                {policy.data.passwordRules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Lockout" subtitle="How long brute force is made to wait" />
          <CardBody className="space-y-3">
            <Field
              label="Failures before lockout"
              hint={`Blank = the platform default of ${effective.lockoutMaxAttempts}.`}
            >
              <Input
                inputMode="numeric"
                placeholder={String(effective.lockoutMaxAttempts)}
                value={form.lockoutMaxAttempts}
                onChange={(e) => set("lockoutMaxAttempts", e.target.value)}
              />
            </Field>
            <Field label="Counting window (minutes)">
              <Input
                inputMode="numeric"
                placeholder={String(effective.lockoutWindowMinutes)}
                value={form.lockoutWindowMinutes}
                onChange={(e) => set("lockoutWindowMinutes", e.target.value)}
              />
            </Field>
            <Field label="Lockout duration (minutes)">
              <Input
                inputMode="numeric"
                placeholder={String(effective.lockoutDurationMinutes)}
                value={form.lockoutDurationMinutes}
                onChange={(e) => set("lockoutDurationMinutes", e.target.value)}
              />
            </Field>
            <p className="text-2xs text-content-subtle">
              A per-IP rule runs alongside this one at four times the threshold, so a password
              spray across many accounts is throttled without one person&rsquo;s mistyping locking
              out a whole office.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Network"
            subtitle="Spec #24 — which addresses may reach this company's data"
          />
          <CardBody className="space-y-3">
            <Field label="Mode">
              <SegmentedControl
                value={form.ipAllowlistMode}
                onChange={(v) => set("ipAllowlistMode", v as PolicyForm["ipAllowlistMode"])}
                options={[
                  { value: "off", label: "Off" },
                  { value: "monitor", label: "Monitor" },
                  { value: "enforce", label: "Enforce" },
                ]}
              />
            </Field>
            <Field
              label="Allowed addresses and ranges"
              hint="One per line. IPv4 and IPv6, bare addresses or CIDR (10.0.0.0/8, 2001:db8::/32)."
            >
              <Textarea
                rows={6}
                className="font-mono text-xs"
                value={form.ipAllowlist}
                onChange={(e) => set("ipAllowlist", e.target.value)}
                placeholder={"203.0.113.0/24\n2001:db8::/32"}
              />
            </Field>
            <Alert tone="warning" size="sm" variant="subtle">
              Start in <strong>monitor</strong>. It records what it would have refused without
              refusing anything, so you can read a week of real traffic before enforcing. The API
              refuses to enforce a list that does not contain the address you are calling from —
              that check is the difference between a security control and an outage.
            </Alert>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Retention"
            subtitle="§0.2 — how long the authentication record is kept about a person"
          />
          <CardBody className="space-y-3">
            <Field
              label="Sign-in audit (days)"
              hint="Blank = kept indefinitely, which is what happens today. Past this age the address, IP and user agent are removed and the kind, outcome and time are kept, so your own counts stay answerable. Minimum 30."
            >
              <Input
                inputMode="numeric"
                placeholder="kept indefinitely"
                value={form.securityEventRetentionDays}
                onChange={(e) => set("securityEventRetentionDays", e.target.value)}
              />
            </Field>
            <Field
              label="Message log (days)"
              hint="Blank = kept indefinitely. These rows are deleted rather than redacted: a preview of a message nobody can identify is not evidence. Minimum 30."
            >
              <Input
                inputMode="numeric"
                placeholder="kept indefinitely"
                value={form.emailDispatchRetentionDays}
                onChange={(e) => set("emailDispatchRetentionDays", e.target.value)}
              />
            </Field>
            <label className="flex items-start gap-2 text-meta">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.legalHold}
                onChange={(e) => set("legalHold", e.target.checked)}
              />
              <span>
                <strong>Legal hold</strong> — suspend every retention sweep for this organisation.
                A hold always beats a retention period; the sweep reports that it skipped you
                rather than reporting that it found nothing.
              </span>
            </label>
            {form.legalHold ? (
              <Field label="Why" hint="Recorded with the policy change and shown on every skipped sweep.">
                <Input
                  value={form.legalHoldReason}
                  placeholder="Adjudication 2026/114 — preserve everything"
                  onChange={(e) => set("legalHoldReason", e.target.value)}
                />
              </Field>
            ) : null}
            <RetentionRun disabled={form.legalHold} />
          </CardBody>
        </Card>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} loading={action.busy === "policy"}>
          Save policy
        </Button>
        <p className="text-2xs text-content-subtle">
          Every change is hash-chained into the company ledger and written to the sign-in audit.
        </p>
      </div>
    </div>
  );
}

/**
 * Run the retention policy now and say exactly what it did.
 *
 * It exists because the alternative — "save the policy and check back
 * tomorrow" — gives an administrator no way to see the consequence of a
 * destructive setting before it has already happened at scale. The run is
 * ledgered server-side, including a run that removed nothing.
 */
function RetentionRun({ disabled }: { disabled: boolean }) {
  const action = useAuthAction();
  const [outcome, setOutcome] = useState<RetentionOutcome | null>(null);

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          loading={action.busy === "retention"}
          onClick={() =>
            void action
              .run("retention", () =>
                api.post<RetentionOutcome>("/api/v1/company/security/retention/run", {}),
              )
              .then((res) => {
                if (res) setOutcome(res);
              })
          }
        >
          Apply retention now
        </Button>
        <p className="text-2xs text-content-subtle">
          {disabled
            ? "Suspended: this organisation is on legal hold."
            : "Runs daily on its own. This is the same sweep, on demand."}
        </p>
      </div>
      <FailureAlert failure={action.failure} onDismiss={action.clear} />
      {outcome ? (
        <Alert
          tone={outcome.skipped ? "info" : "success"}
          size="sm"
          variant="subtle"
          title={outcome.skipped ? "Nothing was removed" : "Retention applied"}
        >
          {outcome.skipped ? (
            outcome.reason
          ) : (
            <>
              {formatNumber(outcome.securityEventsPseudonymised)} audit rows pseudonymised ·{" "}
              {formatNumber(outcome.emailDispatchesDeleted)} message records deleted.
            </>
          )}
        </Alert>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Activity                                                            */
/* ================================================================== */

function ActivityTab() {
  const [outcome, setOutcome] = useState("");
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(1);
  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "50" });
    if (outcome) params.set("outcome", outcome);
    if (kind.trim()) params.set("kind", kind.trim());
    return params.toString();
  }, [outcome, kind, page]);
  const audit = useJson<AuditResponse>(`/api/v1/company/security-events?${query}`, 0);

  const columns = useMemo<DataColumns<AuditEvent>>(
    () => [
      { id: "at", header: "When", accessor: (r) => r.at, type: "text", width: 190, cell: ({ row }) => when(row.at) },
      { id: "kind", header: "Event", accessor: "kind", type: "text", width: 220, mono: true },
      {
        id: "outcome",
        header: "Outcome",
        accessor: "outcome",
        type: "text",
        width: 110,
        cell: ({ row }) => (
          <StatusPill
            status={row.outcome}
            tone={
              row.outcome === "success"
                ? "success"
                : row.outcome === "failure"
                  ? "danger"
                  : row.outcome === "blocked"
                    ? "warning"
                    : "neutral"
            }
          />
        ),
      },
      { id: "email", header: "Address", accessor: (r) => r.email ?? "—", type: "text", width: 220 },
      { id: "ip", header: "From", accessor: (r) => r.ip ?? "—", type: "text", width: 150, mono: true },
      { id: "reason", header: "Reason", accessor: (r) => r.reason ?? "", type: "text", width: 320 },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Outcome" className="w-40">
          <Select value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(1); }}>
            <option value="">Any</option>
            <option value="success">success</option>
            <option value="failure">failure</option>
            <option value="blocked">blocked</option>
            <option value="pending">pending</option>
          </Select>
        </Field>
        <Field label="Event kind" className="w-64" hint="Exact match, e.g. login_failure">
          <Input value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }} />
        </Field>
        <div className="ml-auto flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              window.location.href = `/api/v1/company/security-events/export?format=csv&${query}`;
            }}
          >
            Export CSV
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.location.href = `/api/v1/company/security-events/export?format=json&${query}`;
            }}
          >
            Export JSON
          </Button>
        </div>
      </div>

      {audit.error ? <ErrorAlert message={audit.error} /> : null}
      {audit.data?.reasons.length ? <Reasons reasons={audit.data.reasons} heading="What this view cannot show" /> : null}

      {audit.loading && !audit.data ? (
        <Skeleton height={400} radius="lg" />
      ) : audit.data && audit.data.items.length === 0 ? (
        <EmptyState
          icon={IconActivity}
          title="No sign-in activity matches"
          description="Nothing in this company's trail matches the filters above."
        />
      ) : audit.data ? (
        <>
          <DataTable<AuditEvent>
            tableId="company-security-events"
            data={audit.data.items}
            columns={columns}
            getRowId={(row) => row.id}
            loading={audit.loading}
            height={560}
            rowHeight={44}
            stickyHeader
            gridLines
          />
          <div className="flex items-center justify-between text-2xs text-content-subtle">
            <span>
              {audit.data.total} event{audit.data.total === 1 ? "" : "s"} · page {audit.data.page}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={audit.data.page * audit.data.pageSize >= audit.data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* People                                                              */
/* ================================================================== */

function PeopleTab({ nonce, onChanged }: { nonce: number; onChanged: () => void }) {
  const members = useJson<{ items: Member[]; total: number }>(
    "/api/v1/company/users?pageSize=200",
    nonce,
  );
  const action = useAuthAction();
  const [selected, setSelected] = useState<Member | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function act(member: Member, path: string, key: string, body?: unknown) {
    const res = await action.run(key, () =>
      api.post<Record<string, unknown>>(
        `/api/v1/company/security/users/${member.id}/${path}`,
        body ?? {},
      ),
    );
    if (res) {
      setNote(`${member.email}: ${key.replace(/:.*$/, "")} done.`);
      setSelected(null);
      onChanged();
    }
  }

  if (members.error) return <ErrorAlert message={members.error} />;
  if (members.loading && !members.data) return <Skeleton height={360} radius="lg" />;
  const rows = members.data?.items ?? [];

  return (
    <div className="space-y-3">
      <FailureAlert failure={action.failure} onDismiss={action.clear} />
      {note ? (
        <Alert tone="success" size="sm" onDismiss={() => setNote(null)}>
          {note}
        </Alert>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState icon={IconUsers} title="No members" description="This company has no members." />
      ) : (
        <Card>
          <CardBody className="divide-y divide-border p-0">
            {rows.map((member) => (
              <div key={member.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {member.name}{" "}
                    <Badge tone="neutral" size="xs" className="ml-1">
                      {member.role}
                    </Badge>
                    {member.isActive ? null : (
                      <Badge tone="danger" size="xs" className="ml-1">
                        deactivated
                      </Badge>
                    )}
                  </p>
                  <p className="truncate text-2xs text-content-subtle">
                    {member.email} · last sign-in {when(member.lastLoginAt)}
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setSelected(member)}>
                  Security actions
                </Button>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Security — ${selected.name}` : "Security"}
        width="md"
      >
        {selected ? (
          <div className="space-y-4">
            <Alert tone="neutral" size="sm" variant="subtle">
              You cannot act on your own account from here, and only an owner may act on another
              owner. Both refusals are enforced by the API, not by this page.
            </Alert>
            <Card>
              <CardBody className="space-y-2">
                <p className="text-sm font-semibold">End every session</p>
                <p className="text-2xs text-content-muted">
                  The &ldquo;their laptop was stolen&rdquo; action. The account keeps working; the
                  devices do not.
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={action.busy === `revoke:${selected.id}`}
                    onClick={() => void act(selected, "sessions/revoke", `revoke:${selected.id}`, { scope: "company" })}
                  >
                    In this company
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={action.busy === `revoke-all:${selected.id}`}
                    onClick={() => void act(selected, "sessions/revoke", `revoke-all:${selected.id}`, { scope: "all" })}
                  >
                    Everywhere
                  </Button>
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardBody className="space-y-2">
                <p className="text-sm font-semibold">Clear the second factor</p>
                <p className="text-2xs text-content-muted">
                  For a lost authenticator. Every device that cleared the old factor is signed out,
                  and if your policy requires MFA the next sign-in asks them to enrol again.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={action.busy === `mfa:${selected.id}`}
                  onClick={() => void act(selected, "mfa/reset", `mfa:${selected.id}`)}
                >
                  Reset MFA
                </Button>
              </CardBody>
            </Card>
            <Card>
              <CardBody className="space-y-2">
                <p className="text-sm font-semibold">
                  {selected.isActive ? "Deactivate the account" : "Reactivate the account"}
                </p>
                <p className="text-2xs text-content-muted">
                  {selected.isActive
                    ? "The leaver action: every session and refresh token dies immediately and the account cannot sign in anywhere."
                    : "Restores sign-in. Existing sessions were revoked at deactivation and are not restored."}
                </p>
                <Button
                  size="sm"
                  variant={selected.isActive ? "danger" : "secondary"}
                  loading={action.busy === `active:${selected.id}`}
                  onClick={() =>
                    void act(
                      selected,
                      selected.isActive ? "deactivate" : "reactivate",
                      `active:${selected.id}`,
                    )
                  }
                >
                  {selected.isActive ? "Deactivate" : "Reactivate"}
                </Button>
              </CardBody>
            </Card>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

/* ================================================================== */
/* Directory (SCIM)                                                    */
/* ================================================================== */

function DirectoryTab({ nonce, onChanged }: { nonce: number; onChanged: () => void }) {
  const tokens = useJson<{ items: ScimToken[]; baseUrl: string; reasons: string[] }>(
    "/api/v1/company/scim/tokens",
    nonce,
  );
  const action = useAuthAction();
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<{ token: string; name: string } | null>(null);

  async function create() {
    const res = await action.run("mint", () =>
      api.post<{ token: string; name: string }>("/api/v1/company/scim/tokens", {
        name: name.trim() || "Identity provider",
      }),
    );
    if (res) {
      setMinted(res);
      setName("");
      onChanged();
    }
  }

  async function revoke(token: ScimToken) {
    const res = await action.run(`revoke:${token.id}`, () =>
      api.del(`/api/v1/company/scim/tokens/${token.id}`),
    );
    if (res !== null) onChanged();
  }

  if (tokens.error) return <ErrorAlert message={tokens.error} />;

  return (
    <div className="space-y-4">
      <FailureAlert failure={action.failure} onDismiss={action.clear} />
      <Card>
        <CardHeader
          title="SCIM 2.0 provisioning"
          subtitle="Spec #21 — let your identity provider create, update and deprovision members"
        />
        <CardBody className="space-y-3">
          <div className="rounded-lg border border-border bg-surface-sunken p-3 text-2xs">
            <p className="text-label uppercase text-content-subtle">Base URL</p>
            <code className="select-all font-mono">
              {typeof window === "undefined" ? "" : window.location.origin}
              {tokens.data?.baseUrl ?? "/api/v1/scim/v2"}
            </code>
            <p className="mt-2 text-content-muted">
              Groups are this platform&rsquo;s four company roles (owner, admin, member, guest).
              Per-project permission templates are not exposed — SCIM has no concept of a project,
              so a directory cannot know which projects exist. Setting <code>active: false</code>{" "}
              removes the membership, revokes the sessions opened in this company, and deactivates
              the account entirely when it belongs to no other company.
            </p>
          </div>

          {minted ? (
            <ShowOnce
              title={`Token for ${minted.name}`}
              description="Shown once. Paste it into your identity provider now — only its first ten characters are kept here, so it cannot be retrieved again."
              values={[minted.token]}
              acknowledgeLabel="I have stored it"
              onAcknowledge={() => setMinted(null)}
            />
          ) : null}

          <div className="flex flex-wrap items-end gap-2">
            <Field label="Token name" className="min-w-56 flex-1" hint="Which directory holds it.">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Okta production" />
            </Field>
            <Button onClick={() => void create()} loading={action.busy === "mint"}>
              Mint a token
            </Button>
          </div>

          {tokens.loading && !tokens.data ? (
            <Skeleton height={120} radius="md" />
          ) : (tokens.data?.items ?? []).length === 0 ? (
            <EmptyState
              icon={IconCompliance}
              title="No SCIM tokens"
              description="Nothing is provisioning this company from a directory."
            />
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border">
              {(tokens.data?.items ?? []).map((token) => (
                <div key={token.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-meta font-medium">
                      {token.name}{" "}
                      <Badge tone={token.status === "active" ? "success" : "neutral"} size="xs">
                        {token.status}
                      </Badge>
                    </p>
                    <p className="truncate text-2xs text-content-subtle">
                      <code className="font-mono">{token.tokenPrefix}…</code> · used{" "}
                      {token.useCount} time{token.useCount === 1 ? "" : "s"} · last{" "}
                      {when(token.lastUsedAt)}
                      {token.lastUsedIp ? ` from ${token.lastUsedIp}` : ""}
                    </p>
                  </div>
                  {token.revokedAt ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={action.busy === `revoke:${token.id}`}
                      onClick={() => void revoke(token)}
                    >
                      <IconTrash className="h-3.5 w-3.5" aria-hidden /> Revoke
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ================================================================== */
/* Webhooks                                                            */
/* ================================================================== */

function WebhooksTab({ nonce, onChanged }: { nonce: number; onChanged: () => void }) {
  const hooks = useJson<{ items: Webhook[]; signature: { header: string; scheme: string; note: string } }>(
    "/api/v1/company/security-webhooks",
    nonce,
  );
  const deliveries = useJson<{ items: Delivery[] }>(
    "/api/v1/company/security-webhooks/deliveries?limit=50",
    nonce,
  );
  const action = useAuthAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [kinds, setKinds] = useState("");
  const [minted, setMinted] = useState<{ secret: string; name: string } | null>(null);
  const [tested, setTested] = useState<string | null>(null);

  async function create() {
    const res = await action.run("create", () =>
      api.post<{ secret: string; name: string }>("/api/v1/company/security-webhooks", {
        name: name.trim(),
        url: url.trim(),
        eventKinds: kinds
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    );
    if (res) {
      setMinted(res);
      setOpen(false);
      setName("");
      setUrl("");
      setKinds("");
      onChanged();
    }
  }

  async function test(hook: Webhook) {
    const res = await action.run(`test:${hook.id}`, () =>
      api.post<{ status: string; statusCode: number | null; error: string | null }>(
        `/api/v1/company/security-webhooks/${hook.id}/test`,
        {},
      ),
    );
    if (res) {
      setTested(
        res.status === "delivered"
          ? `${hook.name}: delivered (HTTP ${res.statusCode ?? "?"}).`
          : `${hook.name}: ${res.status}${res.error ? ` — ${res.error}` : ""}. Nothing was confirmed delivered.`,
      );
      onChanged();
    }
  }

  async function remove(hook: Webhook) {
    const res = await action.run(`del:${hook.id}`, () =>
      api.del(`/api/v1/company/security-webhooks/${hook.id}`),
    );
    if (res !== null) onChanged();
  }

  if (hooks.error) return <ErrorAlert message={hooks.error} />;

  return (
    <div className="space-y-4">
      <FailureAlert failure={action.failure} onDismiss={action.clear} />
      {tested ? (
        <Alert tone="info" size="sm" onDismiss={() => setTested(null)}>
          {tested}
        </Alert>
      ) : null}
      {minted ? (
        <ShowOnce
          title={`Signing secret for ${minted.name}`}
          description="Shown once. It is derived from the platform's signing key and never stored, so it cannot be retrieved again."
          values={[minted.secret]}
          acknowledgeLabel="I have stored it"
          onAcknowledge={() => setMinted(null)}
        />
      ) : null}

      <div className="flex items-center justify-between">
        <p className="text-meta text-content-muted">
          Sign-ins, failures, lockouts, policy changes and provisioning, pushed to your SIEM.
          Signed with {hooks.data?.signature.header ?? "x-constructos-signature"} —{" "}
          {hooks.data?.signature.scheme ?? "HMAC-SHA256"}.
        </p>
        <Button size="sm" onClick={() => setOpen(true)}>
          <IconSend className="h-3.5 w-3.5" aria-hidden /> Add endpoint
        </Button>
      </div>

      {hooks.loading && !hooks.data ? (
        <Skeleton height={160} radius="lg" />
      ) : (hooks.data?.items ?? []).length === 0 ? (
        <EmptyState
          icon={IconGlobe}
          title="No endpoints"
          description="Nothing receives this company's security events. The trail is still recorded and readable under Sign-in activity."
        />
      ) : (
        <div className="space-y-2">
          {(hooks.data?.items ?? []).map((hook) => (
            <Card key={hook.id}>
              <CardBody className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {hook.name}{" "}
                    <Badge tone={hook.isEnabled ? "success" : "danger"} size="xs">
                      {hook.isEnabled ? "enabled" : "disabled"}
                    </Badge>
                  </p>
                  <p className="truncate text-2xs text-content-subtle">
                    <code className="font-mono">{hook.url}</code> ·{" "}
                    {hook.eventKinds.length === 0
                      ? "every event kind"
                      : `${hook.eventKinds.length} kind${hook.eventKinds.length === 1 ? "" : "s"}`}{" "}
                    · last {when(hook.lastDeliveryAt)} ({hook.lastStatus ?? "never attempted"})
                  </p>
                  {hook.disabledReason ? (
                    <p className="mt-1 text-2xs text-danger-text">{hook.disabledReason}</p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={action.busy === `test:${hook.id}`}
                  onClick={() => void test(hook)}
                >
                  Send a test
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={action.busy === `del:${hook.id}`}
                  onClick={() => void remove(hook)}
                >
                  <IconTrash className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader
          title="Recent deliveries"
          subtitle="At-least-once. Dedupe on x-constructos-delivery."
        />
        <CardBody>
          {deliveries.loading && !deliveries.data ? (
            <Skeleton height={120} radius="md" />
          ) : (deliveries.data?.items ?? []).length === 0 ? (
            <p className="text-meta text-content-muted">Nothing has been queued yet.</p>
          ) : (
            <div className="divide-y divide-border text-2xs">
              {(deliveries.data?.items ?? []).map((delivery) => (
                <div key={delivery.id} className="flex flex-wrap items-center gap-2 py-1.5">
                  <StatusPill
                    status={delivery.status}
                    tone={
                      delivery.status === "delivered"
                        ? "success"
                        : delivery.status === "pending"
                          ? "info"
                          : "danger"
                    }
                  />
                  <code className="font-mono">{delivery.eventKind}</code>
                  <span className="text-content-subtle">{when(delivery.createdAt)}</span>
                  <span className="text-content-subtle">
                    attempt {delivery.attempts}
                    {delivery.statusCode ? ` · HTTP ${delivery.statusCode}` : ""}
                  </span>
                  {delivery.error ? (
                    <span className="truncate text-danger-text">{delivery.error}</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Drawer open={open} onClose={() => setOpen(false)} title="Add a security webhook" width="md">
        <div className="space-y-3">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Splunk HEC" />
          </Field>
          <Field
            label="Destination URL"
            required
            hint="Must be reachable from the internet and must not resolve inside the platform's own network — that check runs on every delivery, not only here."
          >
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://siem.example.com/hooks/constructos"
            />
          </Field>
          <Field
            label="Event kinds"
            hint="One per line. Leave empty to receive every kind."
          >
            <Textarea
              rows={5}
              className="font-mono text-xs"
              value={kinds}
              onChange={(e) => setKinds(e.target.value)}
              placeholder={"login_failure\naccount_locked\nsecurity_policy_changed"}
            />
          </Field>
          <Button
            fullWidth
            onClick={() => void create()}
            loading={action.busy === "create"}
            disabled={name.trim().length === 0 || url.trim().length === 0}
          >
            Create endpoint
          </Button>
          <p className="text-2xs text-content-subtle">
            The signing secret is shown once, immediately after creation.
          </p>
        </div>
      </Drawer>
    </div>
  );
}
