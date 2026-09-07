import { describe, expect, it } from "vitest";
import {
  assessPasswordWithPolicy,
  emptyPolicy,
  evaluateIpAccess,
  invalidAllowlistEntries,
  ipInAllowlist,
  isIdleExpired,
  parseAddress,
  parseAllowlistEntry,
  PLATFORM_DEFAULT_POLICY,
  policyRules,
  resolvePolicies,
  sessionExpiryAt,
  type StoredSecurityPolicy,
} from "./policy.js";
import { backoffMs, subscribes } from "./webhooks.js";
import { clampDepth, MAX_HISTORY_DEPTH } from "./password-history.js";

/**
 * The tenant security policy engine, as arithmetic and set membership.
 *
 * Everything here is pure, so it is tested without a database. The half that
 * matters most is `resolvePolicies`: half its folds are minima and half are
 * maxima, and getting one backwards silently WEAKENS every tenant a
 * multi-company user belongs to. Each direction has its own test.
 */

function policy(overrides: Partial<StoredSecurityPolicy>): StoredSecurityPolicy {
  return { ...emptyPolicy(overrides.companyId ?? "co-1"), ...overrides };
}

describe("address parsing", () => {
  it("parses dotted-quad IPv4", () => {
    expect(parseAddress("203.0.113.4")).toEqual({ value: 3405803780n, bits: 32 });
    expect(parseAddress("0.0.0.0")).toEqual({ value: 0n, bits: 32 });
    expect(parseAddress("255.255.255.255")).toEqual({ value: 4294967295n, bits: 32 });
  });

  it("refuses malformed IPv4", () => {
    expect(parseAddress("203.0.113")).toBeNull();
    expect(parseAddress("203.0.113.256")).toBeNull();
    expect(parseAddress("203.0.113.4.5")).toBeNull();
    expect(parseAddress("")).toBeNull();
    expect(parseAddress("not-an-address")).toBeNull();
  });

  it("normalises IPv4-mapped IPv6 to plain IPv4, which is what Node hands over", () => {
    // A dual-stack socket reports an IPv4 client as ::ffff:a.b.c.d. An operator
    // who typed 203.0.113.0/24 means that client.
    expect(parseAddress("::ffff:203.0.113.4")).toEqual(parseAddress("203.0.113.4"));
    expect(ipInAllowlist("::ffff:203.0.113.4", ["203.0.113.0/24"])).toBe(true);
  });

  it("parses IPv6 with and without a :: run", () => {
    expect(parseAddress("::1")?.bits).toBe(128);
    expect(parseAddress("::1")?.value).toBe(1n);
    expect(parseAddress("2001:db8:0:0:0:0:0:1")).toEqual(parseAddress("2001:db8::1"));
    expect(parseAddress("fe80::1%eth0")).toEqual(parseAddress("fe80::1"));
  });

  it("refuses an IPv6 literal with too many groups", () => {
    expect(parseAddress("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseAddress("1:2:3:4:5:6:7")).toBeNull();
  });
});

describe("allowlist matching", () => {
  it("matches a bare address exactly", () => {
    expect(ipInAllowlist("203.0.113.4", ["203.0.113.4"])).toBe(true);
    expect(ipInAllowlist("203.0.113.5", ["203.0.113.4"])).toBe(false);
  });

  it("matches inside a CIDR range and not outside it", () => {
    expect(ipInAllowlist("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipInAllowlist("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
    expect(ipInAllowlist("192.168.4.17", ["192.168.4.0/24"])).toBe(true);
    expect(ipInAllowlist("192.168.5.17", ["192.168.4.0/24"])).toBe(false);
  });

  it("handles /0 and /32 at the boundaries", () => {
    expect(ipInAllowlist("8.8.8.8", ["0.0.0.0/0"])).toBe(true);
    expect(ipInAllowlist("8.8.8.8", ["8.8.8.8/32"])).toBe(true);
    expect(ipInAllowlist("8.8.8.9", ["8.8.8.8/32"])).toBe(false);
  });

  it("matches IPv6 ranges and never crosses families", () => {
    expect(ipInAllowlist("2001:db8::5", ["2001:db8::/32"])).toBe(true);
    expect(ipInAllowlist("2001:db9::5", ["2001:db8::/32"])).toBe(false);
    // an IPv4 address is not inside an IPv6 range, whatever the arithmetic says
    expect(ipInAllowlist("203.0.113.4", ["::/0"])).toBe(false);
  });

  it("treats an unparseable address as outside every list", () => {
    expect(ipInAllowlist(null, ["0.0.0.0/0"])).toBe(false);
    expect(ipInAllowlist("garbage", ["0.0.0.0/0"])).toBe(false);
  });

  it("names the entries that do not parse, so a bad CIDR is refused at write time", () => {
    expect(invalidAllowlistEntries(["10.0.0.0/8", "2001:db8::/32", "203.0.113.4"])).toEqual([]);
    expect(invalidAllowlistEntries(["10.0.0.0/33", "nonsense", "10.0.0.0/8"])).toEqual([
      "10.0.0.0/33",
      "nonsense",
    ]);
    expect(parseAllowlistEntry("10.0.0.0/8")?.prefix).toBe(8);
    expect(parseAllowlistEntry("10.0.0.1")?.prefix).toBe(32);
  });
});

describe("evaluateIpAccess", () => {
  const list = ["10.0.0.0/8"];

  it("allows everything when the mode is off", () => {
    const verdict = evaluateIpAccess(
      { ipAllowlistMode: "off", ipAllowlist: list, ipAllowlistBreakGlassUserIds: [] },
      "203.0.113.4",
      "u1",
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.outside).toBe(false);
  });

  it("treats an empty list as off, even in enforce mode", () => {
    // Interpreting "enforce, nothing allowed" literally is a tenant nobody can
    // reach, including the administrator who could fix it.
    const verdict = evaluateIpAccess(
      { ipAllowlistMode: "enforce", ipAllowlist: [], ipAllowlistBreakGlassUserIds: [] },
      "203.0.113.4",
      "u1",
    );
    expect(verdict.allowed).toBe(true);
  });

  it("records but allows in monitor mode", () => {
    const verdict = evaluateIpAccess(
      { ipAllowlistMode: "monitor", ipAllowlist: list, ipAllowlistBreakGlassUserIds: [] },
      "203.0.113.4",
      "u1",
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.outside).toBe(true);
    expect(verdict.reason).toContain("203.0.113.4");
  });

  it("refuses in enforce mode", () => {
    const verdict = evaluateIpAccess(
      { ipAllowlistMode: "enforce", ipAllowlist: list, ipAllowlistBreakGlassUserIds: [] },
      "203.0.113.4",
      "u1",
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.outside).toBe(true);
  });

  it("admits a break-glass user from outside the list, and says so", () => {
    const verdict = evaluateIpAccess(
      { ipAllowlistMode: "enforce", ipAllowlist: list, ipAllowlistBreakGlassUserIds: ["u1"] },
      "203.0.113.4",
      "u1",
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.breakGlass).toBe(true);
    expect(verdict.outside).toBe(true);
  });

  it("refuses a request with no client address when a list is enforced", () => {
    const verdict = evaluateIpAccess(
      { ipAllowlistMode: "enforce", ipAllowlist: list, ipAllowlistBreakGlassUserIds: [] },
      null,
      "u1",
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("no client address");
  });
});

describe("resolvePolicies — strictest wins", () => {
  it("returns the platform defaults when nobody has set anything", () => {
    expect(resolvePolicies([])).toEqual(PLATFORM_DEFAULT_POLICY);
    expect(resolvePolicies([policy({})]).passwordMinLength).toBe(12);
  });

  it("takes the SMALLER of two timeouts", () => {
    const resolved = resolvePolicies([
      policy({ companyId: "a", sessionIdleTimeoutMinutes: 60, sessionAbsoluteTimeoutHours: 48 }),
      policy({ companyId: "b", sessionIdleTimeoutMinutes: 15, sessionAbsoluteTimeoutHours: 8 }),
    ]);
    expect(resolved.sessionIdleTimeoutMinutes).toBe(15);
    expect(resolved.sessionAbsoluteTimeoutHours).toBe(8);
    expect(resolved.sources).toEqual(["a", "b"]);
  });

  it("takes the LARGER password requirement", () => {
    const resolved = resolvePolicies([
      policy({ companyId: "a", passwordMinLength: 16, passwordHistoryDepth: 3 }),
      policy({ companyId: "b", passwordMinLength: 20, passwordHistoryDepth: 10 }),
    ]);
    expect(resolved.passwordMinLength).toBe(20);
    expect(resolved.passwordHistoryDepth).toBe(10);
  });

  it("never lets a tenant lower the platform floor", () => {
    // The schema caps the input at >= 12, but a row written before the cap (or
    // by a migration) must not be able to weaken the platform.
    const resolved = resolvePolicies([policy({ passwordMinLength: 4 })]);
    expect(resolved.passwordMinLength).toBe(12);
  });

  it("ORs the boolean requirements", () => {
    const resolved = resolvePolicies([
      policy({ companyId: "a", passwordRequireComplexity: false, mfaRequired: false }),
      policy({ companyId: "b", passwordRequireComplexity: true, mfaRequired: true }),
    ]);
    expect(resolved.passwordRequireComplexity).toBe(true);
    expect(resolved.mfaRequired).toBe(true);
  });

  it("takes fewer attempts but a LONGER lockout", () => {
    const resolved = resolvePolicies([
      policy({ companyId: "a", lockoutMaxAttempts: 10, lockoutDurationMinutes: 5 }),
      policy({ companyId: "b", lockoutMaxAttempts: 3, lockoutDurationMinutes: 60 }),
    ]);
    expect(resolved.lockoutMaxAttempts).toBe(3);
    expect(resolved.lockoutDurationMinutes).toBe(60);
  });

  it("only lists companies that actually contributed a setting", () => {
    const resolved = resolvePolicies([
      policy({ companyId: "quiet" }),
      policy({ companyId: "loud", passwordMinLength: 14 }),
    ]);
    expect(resolved.sources).toEqual(["loud"]);
  });
});

describe("assessPasswordWithPolicy", () => {
  it("keeps every platform rule", () => {
    const result = assessPasswordWithPolicy("password123", { email: "jane@acme.com" }, PLATFORM_DEFAULT_POLICY);
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(1);
  });

  it("reports the tenant's higher minimum, not the platform's", () => {
    const result = assessPasswordWithPolicy(
      "gantry-crane",
      { email: "jane@acme.com" },
      { passwordMinLength: 20, passwordRequireComplexity: false },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("at least 20 characters");
    expect(result.reasons.join(" ")).toContain("your organisation");
  });

  it("names every missing character class at once", () => {
    const result = assessPasswordWithPolicy(
      "gantrycranelintel",
      { email: "jane@acme.com" },
      { passwordMinLength: 12, passwordRequireComplexity: true },
    );
    expect(result.ok).toBe(false);
    const text = result.reasons.join(" ");
    expect(text).toContain("an upper-case letter");
    expect(text).toContain("a digit");
    expect(text).toContain("a symbol");
  });

  it("accepts a password that clears both the platform and the tenant", () => {
    const result = assessPasswordWithPolicy(
      "Gantry-Crane-Lintel-9",
      { email: "jane@acme.com", name: "Jane Rivera" },
      { passwordMinLength: 16, passwordRequireComplexity: true },
    );
    expect(result).toEqual({ ok: true, reasons: [] });
  });

  it("publishes the rules a form should show", () => {
    const rules = policyRules({
      ...PLATFORM_DEFAULT_POLICY,
      passwordMinLength: 16,
      passwordRequireComplexity: true,
      passwordHistoryDepth: 5,
      passwordMaxAgeDays: 90,
    });
    expect(rules.join(" ")).toContain("At least 16");
    expect(rules.join(" ")).toContain("last 5 passwords");
    expect(rules.join(" ")).toContain("every 90 days");
  });
});

describe("session lifetimes", () => {
  it("computes an absolute expiry from the tenant's hours", () => {
    const at = sessionExpiryAt({ ...PLATFORM_DEFAULT_POLICY, sessionAbsoluteTimeoutHours: 8 }, 0);
    expect(at).toBe(new Date(8 * 3600_000).toISOString());
  });

  it("never times out an idle session when no idle limit is set", () => {
    expect(isIdleExpired({ sessionIdleTimeoutMinutes: null }, new Date(0).toISOString(), 1e12)).toBe(
      false,
    );
  });

  it("times out only past the limit", () => {
    const lastSeen = new Date(1_000_000).toISOString();
    expect(isIdleExpired({ sessionIdleTimeoutMinutes: 15 }, lastSeen, 1_000_000 + 14 * 60_000)).toBe(
      false,
    );
    expect(isIdleExpired({ sessionIdleTimeoutMinutes: 15 }, lastSeen, 1_000_000 + 16 * 60_000)).toBe(
      true,
    );
  });

  it("does not time out on an unparseable lastSeenAt", () => {
    expect(isIdleExpired({ sessionIdleTimeoutMinutes: 15 }, "not-a-date", 1e12)).toBe(false);
  });
});

describe("password history depth", () => {
  it("clamps to the ceiling and treats nothing as zero", () => {
    expect(clampDepth(null)).toBe(0);
    expect(clampDepth(0)).toBe(0);
    expect(clampDepth(-3)).toBe(0);
    expect(clampDepth(5)).toBe(5);
    expect(clampDepth(1000)).toBe(MAX_HISTORY_DEPTH);
  });
});

describe("security webhook arithmetic", () => {
  it("backs off quadratically and stops climbing at thirty minutes", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(4 * 60_000);
    expect(backoffMs(3)).toBe(9 * 60_000);
    expect(backoffMs(10)).toBe(30 * 60_000);
  });

  it("treats an empty subscription as every kind", () => {
    expect(subscribes([], "login_failure")).toBe(true);
    expect(subscribes(["login_failure"], "login_failure")).toBe(true);
    expect(subscribes(["login_failure"], "login_success")).toBe(false);
  });
});
