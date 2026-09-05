import { eq, inArray } from "drizzle-orm";
import { companyMemberships, companySecurityPolicies, companies } from "@constructos/db";
import {
  SECURITY_POLICY_DEFAULTS,
  type IpAllowlistMode,
} from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { assessPassword, type PasswordAssessment, type PasswordContext } from "./password.js";

/**
 * THE TENANT SECURITY POLICY ENGINE — spec #23 (session timeout), #24 (IP
 * allowlisting), #25 (password policy).
 *
 * Covers: reading a tenant's stored policy, resolving the EFFECTIVE policy for
 * a person who belongs to several tenants, matching an address against a
 * CIDR allowlist, and evaluating a candidate password against the resolved
 * rules. Everything in this file is pure except the two loaders at the bottom,
 * which is what makes the rules testable without a database.
 *
 * Deliberately NOT here: enforcement. A policy engine that also decides which
 * HTTP status to return ends up with its rules spread across route handlers.
 * The callers are: modules/account/index.ts (password change, policy CRUD),
 * modules/mfa/index.ts and modules/identity via login.ts (the login gate),
 * plugins/auth.ts (idle timeout — see the proposed diff in the WP report).
 *
 * ------------------------------------------------------------------------
 * THE ONE RULE THAT IS NOT OBVIOUS: STRICTEST WINS ACROSS TENANTS
 * ------------------------------------------------------------------------
 * A person can be a member of several companies, and a session is an
 * ACCOUNT-level object — one token reads data from every tenant the holder
 * belongs to. So the policy that governs the session must be the strictest of
 * the tenants it can reach, not the one whose header happened to be on the
 * request. Anything else means a member of a lax tenant holds a long-lived,
 * short-password session and then reads a strict tenant's records through it.
 * `isPasswordLoginAllowedForUser` in modules/sso/policy.ts already reasons
 * this way for password sign-in; this generalises it.
 *
 * The IP allowlist is the exception, and it has to be: intersecting the
 * allowlists of several tenants would produce an empty set and lock the user
 * out of all of them. It is therefore evaluated PER TENANT, at the point the
 * tenant is named (`requireCompany`), which is also the only point where the
 * question "may this address reach THIS company's data" is meaningful.
 */

export type SecurityPolicyRow = typeof companySecurityPolicies.$inferSelect;

/** What a tenant has actually stored. `null` means "platform default". */
export interface StoredSecurityPolicy {
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
  ipAllowlistMode: IpAllowlistMode;
  ipAllowlist: string[];
  ipAllowlistBreakGlassUserIds: string[];
  mfaRequired: boolean;
  mfaAcceptedAmrValues: string[];
  /* §0.2 #46/#47 — data lifecycle. null on both means "keep indefinitely",
   * which is what the platform did before there was a policy, so a tenant
   * that has chosen nothing is not silently opted into deletion. */
  securityEventRetentionDays: number | null;
  emailDispatchRetentionDays: number | null;
  legalHold: boolean;
  legalHoldReason: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** The policy after platform defaults are applied. Nothing is null but the
 *  three settings whose default genuinely IS "no limit". */
export interface ResolvedSecurityPolicy {
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
  /** which tenants contributed a value to this resolution, for the "why" */
  sources: string[];
}

export const PLATFORM_DEFAULT_POLICY: ResolvedSecurityPolicy = {
  sessionIdleTimeoutMinutes: SECURITY_POLICY_DEFAULTS.sessionIdleTimeoutMinutes,
  sessionAbsoluteTimeoutHours: SECURITY_POLICY_DEFAULTS.sessionAbsoluteTimeoutHours,
  rememberDeviceDays: SECURITY_POLICY_DEFAULTS.rememberDeviceDays,
  passwordMinLength: SECURITY_POLICY_DEFAULTS.passwordMinLength,
  passwordRequireComplexity: SECURITY_POLICY_DEFAULTS.passwordRequireComplexity,
  passwordHistoryDepth: SECURITY_POLICY_DEFAULTS.passwordHistoryDepth,
  passwordMaxAgeDays: SECURITY_POLICY_DEFAULTS.passwordMaxAgeDays,
  lockoutMaxAttempts: SECURITY_POLICY_DEFAULTS.lockoutMaxAttempts,
  lockoutWindowMinutes: SECURITY_POLICY_DEFAULTS.lockoutWindowMinutes,
  lockoutDurationMinutes: SECURITY_POLICY_DEFAULTS.lockoutDurationMinutes,
  mfaRequired: false,
  sources: [],
};

/** A stored row for a tenant that has never opened the page. */
export function emptyPolicy(companyId: string): StoredSecurityPolicy {
  return {
    companyId,
    sessionIdleTimeoutMinutes: null,
    sessionAbsoluteTimeoutHours: null,
    rememberDeviceDays: null,
    passwordMinLength: null,
    passwordRequireComplexity: false,
    passwordHistoryDepth: null,
    passwordMaxAgeDays: null,
    lockoutMaxAttempts: null,
    lockoutWindowMinutes: null,
    lockoutDurationMinutes: null,
    ipAllowlistMode: "off",
    ipAllowlist: [],
    ipAllowlistBreakGlassUserIds: [],
    mfaRequired: false,
    mfaAcceptedAmrValues: [],
    securityEventRetentionDays: null,
    emailDispatchRetentionDays: null,
    legalHold: false,
    legalHoldReason: null,
    updatedBy: null,
    updatedAt: null,
  };
}

export function rowToPolicy(row: SecurityPolicyRow): StoredSecurityPolicy {
  return {
    companyId: row.companyId,
    sessionIdleTimeoutMinutes: row.sessionIdleTimeoutMinutes,
    sessionAbsoluteTimeoutHours: row.sessionAbsoluteTimeoutHours,
    rememberDeviceDays: row.rememberDeviceDays,
    passwordMinLength: row.passwordMinLength,
    passwordRequireComplexity: row.passwordRequireComplexity,
    passwordHistoryDepth: row.passwordHistoryDepth,
    passwordMaxAgeDays: row.passwordMaxAgeDays,
    lockoutMaxAttempts: row.lockoutMaxAttempts,
    lockoutWindowMinutes: row.lockoutWindowMinutes,
    lockoutDurationMinutes: row.lockoutDurationMinutes,
    ipAllowlistMode: row.ipAllowlistMode as IpAllowlistMode,
    ipAllowlist: row.ipAllowlist ?? [],
    ipAllowlistBreakGlassUserIds: row.ipAllowlistBreakGlassUserIds ?? [],
    mfaRequired: row.mfaRequired,
    mfaAcceptedAmrValues: row.mfaAcceptedAmrValues ?? [],
    securityEventRetentionDays: row.securityEventRetentionDays,
    emailDispatchRetentionDays: row.emailDispatchRetentionDays,
    legalHold: row.legalHold,
    legalHoldReason: row.legalHoldReason,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Resolution — strictest wins                                         */
/* ------------------------------------------------------------------ */

/** The smaller of two limits, treating null as "no limit". */
function tighterLimit(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** The larger of two requirements, treating null as "no requirement". */
function higherRequirement(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * Fold every tenant's stored policy into the one that governs this person.
 *
 * Read the direction of each fold carefully — half of them are minima and half
 * are maxima, and getting one backwards silently WEAKENS the platform:
 *
 *   timeouts, lockout window/attempts   → the SMALLER number is stricter
 *   password length / history / complexity, lockout duration, MFA
 *                                       → the LARGER (or `true`) is stricter
 */
export function resolvePolicies(policies: readonly StoredSecurityPolicy[]): ResolvedSecurityPolicy {
  const out: ResolvedSecurityPolicy = { ...PLATFORM_DEFAULT_POLICY, sources: [] };
  let idle: number | null = null;
  let absolute: number | null = null;
  let remember: number | null = null;
  let minLength: number | null = null;
  let history: number | null = null;
  let maxAge: number | null = null;
  let attempts: number | null = null;
  let window: number | null = null;
  let duration: number | null = null;

  for (const p of policies) {
    let contributed = false;
    if (p.sessionIdleTimeoutMinutes !== null) {
      idle = tighterLimit(idle, p.sessionIdleTimeoutMinutes);
      contributed = true;
    }
    if (p.sessionAbsoluteTimeoutHours !== null) {
      absolute = tighterLimit(absolute, p.sessionAbsoluteTimeoutHours);
      contributed = true;
    }
    if (p.rememberDeviceDays !== null) {
      remember = tighterLimit(remember, p.rememberDeviceDays);
      contributed = true;
    }
    if (p.passwordMinLength !== null) {
      minLength = higherRequirement(minLength, p.passwordMinLength);
      contributed = true;
    }
    if (p.passwordRequireComplexity) {
      out.passwordRequireComplexity = true;
      contributed = true;
    }
    if (p.passwordHistoryDepth !== null) {
      history = higherRequirement(history, p.passwordHistoryDepth);
      contributed = true;
    }
    if (p.passwordMaxAgeDays !== null) {
      maxAge = tighterLimit(maxAge, p.passwordMaxAgeDays);
      contributed = true;
    }
    if (p.lockoutMaxAttempts !== null) {
      attempts = tighterLimit(attempts, p.lockoutMaxAttempts);
      contributed = true;
    }
    if (p.lockoutWindowMinutes !== null) {
      window = tighterLimit(window, p.lockoutWindowMinutes);
      contributed = true;
    }
    if (p.lockoutDurationMinutes !== null) {
      duration = higherRequirement(duration, p.lockoutDurationMinutes);
      contributed = true;
    }
    if (p.mfaRequired) {
      out.mfaRequired = true;
      contributed = true;
    }
    if (contributed) out.sources.push(p.companyId);
  }

  out.sessionIdleTimeoutMinutes = idle;
  if (absolute !== null) out.sessionAbsoluteTimeoutHours = absolute;
  if (remember !== null) out.rememberDeviceDays = remember;
  // The platform floor is a floor: a tenant may raise the minimum length, never
  // lower it below what modules/account/password.ts refuses anyway.
  out.passwordMinLength = Math.max(PLATFORM_DEFAULT_POLICY.passwordMinLength, minLength ?? 0);
  out.passwordHistoryDepth = history ?? 0;
  out.passwordMaxAgeDays = maxAge;
  if (attempts !== null) out.lockoutMaxAttempts = attempts;
  if (window !== null) out.lockoutWindowMinutes = window;
  if (duration !== null) out.lockoutDurationMinutes = duration;
  return out;
}

/* ------------------------------------------------------------------ */
/* #24 — IP allowlisting                                              */
/* ------------------------------------------------------------------ */

interface ParsedAddress {
  value: bigint;
  bits: 32 | 128;
}

/** Parse a dotted-quad into a 32-bit integer. Null on anything malformed. */
function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

/**
 * Parse an address to a comparable integer.
 *
 * IPv4-mapped IPv6 (`::ffff:203.0.113.4`) is normalised to plain IPv4,
 * because that is what Node hands over for an IPv4 client on a dual-stack
 * socket and an operator who typed `203.0.113.0/24` means that client.
 */
export function parseAddress(raw: string): ParsedAddress | null {
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return null;
  // strip a zone id (fe80::1%eth0) — it is interface scope, not address
  const bare = text.includes("%") ? text.slice(0, text.indexOf("%")) : text;
  if (!bare.includes(":")) {
    const v4 = parseIpv4(bare);
    return v4 === null ? null : { value: v4, bits: 32 };
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped?.[1]) {
    const v4 = parseIpv4(mapped[1]);
    return v4 === null ? null : { value: v4, bits: 32 };
  }
  // full IPv6, possibly with a trailing dotted-quad and one "::" run
  let head = bare;
  let tailV4 = 0n;
  let tailGroups = 0;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (dotted?.[1]) {
    const v4 = parseIpv4(dotted[1]);
    if (v4 === null) return null;
    tailV4 = v4;
    tailGroups = 2;
    head = bare.slice(0, bare.length - dotted[1].length);
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
    else if (head.endsWith("::")) head = `${head}0`;
  }
  const doubleColon = head.indexOf("::");
  let groups: string[];
  if (doubleColon === -1) {
    groups = head.split(":").filter((g) => g.length > 0);
    if (groups.length + tailGroups !== 8) return null;
  } else {
    const left = head.slice(0, doubleColon).split(":").filter((g) => g.length > 0);
    const right = head.slice(doubleColon + 2).split(":").filter((g) => g.length > 0);
    const fill = 8 - tailGroups - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array<string>(fill).fill("0"), ...right];
  }
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  if (tailGroups === 2) value = (value << 32n) | tailV4;
  return { value, bits: 128 };
}

export interface AllowlistEntry {
  raw: string;
  address: ParsedAddress;
  prefix: number;
}

/** Parse one allowlist entry (`1.2.3.4`, `10.0.0.0/8`, `2001:db8::/32`). */
export function parseAllowlistEntry(raw: string): AllowlistEntry | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const slash = text.lastIndexOf("/");
  const host = slash === -1 ? text : text.slice(0, slash);
  const address = parseAddress(host);
  if (!address) return null;
  // Annotated: `address.bits` is the literal union 32 | 128, so an inferred
  // `let` would refuse the parsed CIDR suffix below.
  let prefix: number = address.bits;
  if (slash !== -1) {
    const suffix = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(suffix)) return null;
    prefix = Number(suffix);
    if (prefix > address.bits) return null;
  }
  return { raw: text, address, prefix };
}

/** Every entry that failed to parse, so a bad CIDR is refused at write time
 *  rather than silently admitting nobody. */
export function invalidAllowlistEntries(entries: readonly string[]): string[] {
  return entries.filter((e) => parseAllowlistEntry(e) === null);
}

function masked(value: bigint, bits: number, prefix: number): bigint {
  if (prefix === 0) return 0n;
  const shift = BigInt(bits - prefix);
  return (value >> shift) << shift;
}

/** Does this address fall inside any entry? An unparseable address never does. */
export function ipInAllowlist(ip: string | null | undefined, entries: readonly string[]): boolean {
  if (!ip) return false;
  const address = parseAddress(ip);
  if (!address) return false;
  for (const raw of entries) {
    const entry = parseAllowlistEntry(raw);
    if (!entry) continue;
    if (entry.address.bits !== address.bits) continue;
    if (masked(address.value, address.bits, entry.prefix) === masked(entry.address.value, entry.address.bits, entry.prefix)) {
      return true;
    }
  }
  return false;
}

export interface IpVerdict {
  /** may the request proceed? `monitor` mode always allows and records */
  allowed: boolean;
  mode: IpAllowlistMode;
  /** true when the address was outside the list, whatever the mode did */
  outside: boolean;
  breakGlass: boolean;
  reason: string | null;
}

/**
 * Evaluate one tenant's allowlist against one request.
 *
 * THE THREE MODES, and why `monitor` exists at all: an allowlist typed from
 * memory locks a company out of its own platform on a Friday afternoon. The
 * honest way to introduce one is to run it in `monitor` for a week, read the
 * `login_blocked_ip` rows it would have produced, and only then enforce.
 *
 * An EMPTY list in `enforce` mode is treated as "off", not as "nobody". An
 * administrator who enabled enforcement and has not yet added an entry has
 * made a mistake, and the failure mode of interpreting it literally is a
 * tenant nobody can reach, including the administrator who could fix it.
 */
export function evaluateIpAccess(
  policy: Pick<StoredSecurityPolicy, "ipAllowlistMode" | "ipAllowlist" | "ipAllowlistBreakGlassUserIds">,
  ip: string | null,
  userId: string | null,
): IpVerdict {
  const mode = policy.ipAllowlistMode;
  if (mode === "off" || policy.ipAllowlist.length === 0) {
    return { allowed: true, mode, outside: false, breakGlass: false, reason: null };
  }
  if (ipInAllowlist(ip, policy.ipAllowlist)) {
    return { allowed: true, mode, outside: false, breakGlass: false, reason: null };
  }
  const breakGlass = Boolean(userId && policy.ipAllowlistBreakGlassUserIds.includes(userId));
  if (breakGlass) {
    return {
      allowed: true,
      mode,
      outside: true,
      breakGlass: true,
      reason: "Address is outside the allowlist; admitted under the break-glass exemption.",
    };
  }
  const reason =
    ip === null
      ? "The request carried no client address, so it cannot be matched against the allowlist."
      : `Address ${ip} is not inside any of the ${policy.ipAllowlist.length} allowed ranges.`;
  return { allowed: mode !== "enforce", mode, outside: true, breakGlass: false, reason };
}

/* ------------------------------------------------------------------ */
/* #25 — password rules under a tenant policy                          */
/* ------------------------------------------------------------------ */

const CLASSES: Array<[RegExp, string]> = [
  [/[a-z]/, "a lower-case letter"],
  [/[A-Z]/, "an upper-case letter"],
  [/[0-9]/, "a digit"],
  [/[^A-Za-z0-9]/, "a symbol"],
];

/**
 * The platform's own rules (length floor, common-password list, no email local
 * part, no own name) PLUS whatever the tenant has raised.
 *
 * Returns every reason at once, the same discipline `assessPassword` keeps:
 * a user should see the whole bill, not discover it one round trip at a time.
 */
export function assessPasswordWithPolicy(
  password: string,
  context: PasswordContext,
  policy: Pick<ResolvedSecurityPolicy, "passwordMinLength" | "passwordRequireComplexity">,
): PasswordAssessment {
  const base = assessPassword(password, context);
  const reasons = [...base.reasons];
  if (password.length < policy.passwordMinLength) {
    const already = reasons.some((r) => r.startsWith("Password must be at least"));
    if (!already) {
      reasons.push(
        `Password must be at least ${policy.passwordMinLength} characters (set by your organisation).`,
      );
    } else if (policy.passwordMinLength > PLATFORM_DEFAULT_POLICY.passwordMinLength) {
      // Replace the platform message with the tenant's higher number, so the
      // user is told the bar they actually have to clear.
      const idx = reasons.findIndex((r) => r.startsWith("Password must be at least"));
      reasons[idx] = `Password must be at least ${policy.passwordMinLength} characters (set by your organisation).`;
    }
  }
  if (policy.passwordRequireComplexity) {
    const missing = CLASSES.filter(([re]) => !re.test(password)).map(([, label]) => label);
    if (missing.length > 0) {
      reasons.push(`Password must contain ${missing.join(", ")}.`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** The human-readable rules a form can show before asking. */
export function policyRules(policy: ResolvedSecurityPolicy): string[] {
  const rules = [
    `At least ${policy.passwordMinLength} characters.`,
    "Not one of the most commonly used passwords.",
    "Must not contain the local part of your email address.",
    "Must not be your own name.",
  ];
  if (policy.passwordRequireComplexity) {
    rules.push("Must mix upper case, lower case, a digit and a symbol.");
  }
  if (policy.passwordHistoryDepth > 0) {
    rules.push(`Must not be one of your last ${policy.passwordHistoryDepth} passwords.`);
  }
  if (policy.passwordMaxAgeDays !== null) {
    rules.push(`Must be changed every ${policy.passwordMaxAgeDays} days.`);
  }
  return rules;
}

/* ------------------------------------------------------------------ */
/* #23 — session lifetimes                                             */
/* ------------------------------------------------------------------ */

/** Absolute expiry for a session opened now, under the resolved policy. */
export function sessionExpiryAt(policy: ResolvedSecurityPolicy, nowMs: number): string {
  return new Date(nowMs + policy.sessionAbsoluteTimeoutHours * 3600_000).toISOString();
}

/**
 * Has this session been idle longer than the tenant permits?
 *
 * `lastSeenAt` is refreshed at most once a minute (sessions.ts), so the
 * measurement is coarse by design; a timeout shorter than a couple of minutes
 * is therefore not honoured precisely and the policy route refuses one.
 */
export function isIdleExpired(
  policy: Pick<ResolvedSecurityPolicy, "sessionIdleTimeoutMinutes">,
  lastSeenAt: string,
  nowMs: number,
): boolean {
  if (policy.sessionIdleTimeoutMinutes === null) return false;
  const last = Date.parse(lastSeenAt);
  if (!Number.isFinite(last)) return false;
  return nowMs - last > policy.sessionIdleTimeoutMinutes * 60_000;
}

/* ------------------------------------------------------------------ */
/* Loaders                                                             */
/* ------------------------------------------------------------------ */

export async function loadCompanyPolicy(db: Db, companyId: string): Promise<StoredSecurityPolicy> {
  const [row] = await db
    .select()
    .from(companySecurityPolicies)
    .where(eq(companySecurityPolicies.companyId, companyId))
    .limit(1);
  return row ? rowToPolicy(row) : emptyPolicy(companyId);
}

/** Every tenant this user belongs to, with its stored policy. */
export async function loadUserPolicies(db: Db, userId: string): Promise<StoredSecurityPolicy[]> {
  const memberships = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(eq(companyMemberships.userId, userId));
  if (memberships.length === 0) return [];
  const ids = memberships.map((m) => m.companyId);
  const rows = await db
    .select()
    .from(companySecurityPolicies)
    .where(inArray(companySecurityPolicies.companyId, ids));
  const byCompany = new Map(rows.map((r) => [r.companyId, rowToPolicy(r)]));
  return ids.map((id) => byCompany.get(id) ?? emptyPolicy(id));
}

/** The effective policy governing one account. */
export async function effectivePolicyForUser(
  db: Db,
  userId: string,
): Promise<ResolvedSecurityPolicy> {
  return resolvePolicies(await loadUserPolicies(db, userId));
}

/**
 * The effective policy for an ADDRESS that may or may not have an account.
 *
 * Used by the login gate before the password is checked, so it must behave
 * identically for an address with no account: it returns the platform default,
 * which is what an unknown address would get anyway. No enumeration signal.
 */
export async function effectivePolicyForEmail(
  db: Db,
  email: string,
): Promise<ResolvedSecurityPolicy> {
  const { users } = await import("@constructos/db");
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!user) return { ...PLATFORM_DEFAULT_POLICY };
  return effectivePolicyForUser(db, user.id);
}

/** Company name + stored policy, for the administration page. */
export async function loadCompanyPolicyWithName(
  db: Db,
  companyId: string,
): Promise<{ policy: StoredSecurityPolicy; companyName: string | null }> {
  const policy = await loadCompanyPolicy(db, companyId);
  const [company] = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return { policy, companyName: company?.name ?? null };
}
