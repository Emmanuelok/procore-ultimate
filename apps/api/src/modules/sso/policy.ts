/**
 * The decisions that are policy rather than protocol.
 *
 * `oidc.ts` establishes WHAT the identity provider asserted. This file decides
 * what the platform is willing to do about it: whether an asserted address is
 * inside a domain this connection is entitled to speak for, what role a group
 * claim earns, whether a connection is fit to be switched on, and — the one
 * that keeps people locked out of their own accounts if it is wrong — whether
 * a user still has a way in after removing a sign-in method.
 *
 * These are separated from the routes because they are the parts worth testing
 * in isolation and worth reading in one sitting.
 */
import type { CompanyRole } from "@constructos/shared";
import type { Config } from "../../config.js";

/* ------------------------------------------------------------------ */
/* Email domains                                                       */
/* ------------------------------------------------------------------ */

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain === "" ? null : domain;
}

export function normalizeDomains(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const cleaned = value.trim().toLowerCase().replace(/^@+/, "").replace(/\.+$/, "");
    if (cleaned !== "" && !out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

/**
 * Is this address inside a domain the connection may speak for?
 *
 * An EMPTY allow-list means "no domain", not "every domain". That reading is
 * deliberate and is the opposite of what a permissive default would do: an
 * administrator who has not yet said which domains their identity provider
 * owns has not authorised it to claim anybody, and a connection that matches
 * every address is a connection that can assert `ceo@some-other-company.com`.
 */
export function domainAllowed(allowed: readonly string[], email: string): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  const list = normalizeDomains(allowed);
  return list.includes(domain);
}

/* ------------------------------------------------------------------ */
/* Group → role mapping                                                */
/* ------------------------------------------------------------------ */

export interface GroupRoleMapping {
  claimValue: string;
  companyRole: CompanyRole;
  templateKey?: string | null;
}

export function parseGroupMappings(raw: unknown): GroupRoleMapping[] {
  if (!Array.isArray(raw)) return [];
  const out: GroupRoleMapping[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const claimValue = record["claimValue"];
    const companyRole = record["companyRole"];
    if (typeof claimValue !== "string" || typeof companyRole !== "string") continue;
    const templateKey = record["templateKey"];
    out.push({
      claimValue,
      companyRole: companyRole as CompanyRole,
      templateKey: typeof templateKey === "string" ? templateKey : null,
    });
  }
  return out;
}

export interface ResolvedRole {
  companyRole: CompanyRole;
  templateKey: string | null;
  /** which mapping decided it, or null when the connection default applied */
  matchedClaimValue: string | null;
}

/** First match wins, in the order the administrator wrote them. */
export function resolveRole(
  mappings: readonly GroupRoleMapping[],
  groups: readonly string[],
  fallback: { companyRole: CompanyRole; templateKey: string | null },
): ResolvedRole {
  for (const mapping of mappings) {
    if (groups.includes(mapping.claimValue)) {
      return {
        companyRole: mapping.companyRole,
        templateKey: mapping.templateKey ?? fallback.templateKey,
        matchedClaimValue: mapping.claimValue,
      };
    }
  }
  return { ...fallback, matchedClaimValue: null };
}

/* ------------------------------------------------------------------ */
/* Passwords that are not passwords                                    */
/* ------------------------------------------------------------------ */

/**
 * `users.password_hash` is NOT NULL, so a user created by SSO still needs a
 * value in it. Writing a bcrypt hash of a random string would be safe but
 * indistinguishable from a real password, and this module has to be able to
 * answer "does this person have any way in other than SSO?" before it lets
 * them unlink their last identity.
 *
 * So a provisioned user's hash is prefixed. `bcrypt.compare` returns false for
 * a malformed hash (verified, not assumed), so the existing password login
 * route rejects it as ordinary bad credentials — no new code path, no 500 —
 * and the prefix disappears by itself the moment the account module writes a
 * real hash over it.
 */
export const SSO_ONLY_PASSWORD_PREFIX = "sso-only:";

export function markSsoOnlyPassword(hash: string): string {
  return `${SSO_ONLY_PASSWORD_PREFIX}${hash}`;
}

export function hasUsablePassword(passwordHash: string | null | undefined): boolean {
  if (!passwordHash || passwordHash === "") return false;
  return !passwordHash.startsWith(SSO_ONLY_PASSWORD_PREFIX);
}

/* ------------------------------------------------------------------ */
/* Sign-in methods                                                     */
/* ------------------------------------------------------------------ */

export interface SignInMethods {
  /** a password that could actually be typed, and that policy still permits */
  password: boolean;
  /** reason the password is not counted, when it is not */
  passwordReasons: string[];
  identityIds: string[];
}

/**
 * How many ways in does this account have, right now?
 *
 * The count has to include policy, not just credentials: a user whose company
 * has switched password login off does not have a password sign-in method, no
 * matter what is in `password_hash`, and unlinking their only identity would
 * lock them out completely.
 */
export function countSignInMethods(methods: SignInMethods): number {
  return (methods.password ? 1 : 0) + methods.identityIds.length;
}

/* ------------------------------------------------------------------ */
/* Connection readiness                                                */
/* ------------------------------------------------------------------ */

export interface ProviderReadinessInput {
  kind: string;
  clientId: string | null;
  issuer: string | null;
  discoveryUrl: string | null;
  authorizationUrl: string | null;
  tokenUrl: string | null;
  jwksUri: string | null;
  secretStorage: string;
  clientSecretCiphertext: string | null;
  clientSecretRef: string | null;
  allowedEmailDomains: string[];
  autoProvision: boolean;
  domainsVerifiedAt: string | null;
}

export interface ProviderReadiness {
  /**
   * null when the connection cannot be judged usable — the house shape for an
   * answer that has missing inputs. `reasons` says exactly what is missing,
   * in the words the administrator needs to fix it.
   */
  ready: boolean | null;
  reasons: string[];
}

export function providerReadiness(
  p: ProviderReadinessInput,
  /** returns the reasons a `reference` secret cannot be resolved; [] when it can */
  resolveReference?: (ref: string) => string[],
): ProviderReadiness {
  const reasons: string[] = [];

  if (p.kind === "saml") {
    return {
      ready: null,
      reasons: [SAML_UNSUPPORTED_REASON],
    };
  }

  if (!p.clientId) reasons.push("clientId is not set.");
  if (!p.issuer) {
    reasons.push("issuer is not set — it is the anchor every id_token is checked against.");
  }
  if (!p.authorizationUrl || !p.tokenUrl || !p.jwksUri) {
    reasons.push(
      p.discoveryUrl
        ? "Endpoints have not been read from the discovery document yet — " +
          "POST /identity-providers/:id/discovery to fetch them."
        : "No discoveryUrl, and authorizationUrl / tokenUrl / jwksUri are not all set.",
    );
  }
  if (p.secretStorage === "encrypted" && !p.clientSecretCiphertext) {
    reasons.push(
      "secretStorage is `encrypted` but no client secret has been stored. Send `clientSecret` " +
        "on a PATCH, or set secretStorage to `none` for a public PKCE client.",
    );
  }
  if (p.secretStorage === "reference") {
    if (!p.clientSecretRef) {
      reasons.push("secretStorage is `reference` but clientSecretRef is empty.");
    } else if (resolveReference) {
      // A reference that names a variable nobody set, or a scheme this build
      // has no resolver for, is NOT a configured secret. Judging readiness on
      // the presence of the string alone reported `ready: true` for a
      // connection whose very first sign-in answered 503 — a green light for
      // something that cannot work is exactly the fabricated verdict this
      // shape exists to avoid. The resolver is injected so this function
      // stays pure and testable.
      reasons.push(...resolveReference(p.clientSecretRef));
    }
  }
  if (p.allowedEmailDomains.length === 0) {
    reasons.push(
      "allowedEmailDomains is empty, so this connection may not claim any address. " +
        "List the domains this identity provider owns.",
    );
  }
  if (p.autoProvision && !p.domainsVerifiedAt) {
    reasons.push(
      "autoProvision is on but the domains have not been confirmed — " +
        "POST /identity-providers/:id/verify-domains once you control them. " +
        "Creating accounts from an unverified domain claim is how a tenant gets taken over.",
    );
  }

  return { ready: reasons.length === 0, reasons };
}

export const SAML_UNSUPPORTED_REASON =
  "SAML 2.0 is configurable here but cannot be used to sign in on this build. Verifying a SAML " +
  "assertion requires XML Digital Signature verification — canonicalisation (Exclusive C14N), " +
  "reference/transform processing and signature checking over the assertion element — and this " +
  "repository ships no XML-DSIG implementation. A partial verifier is not a smaller feature than " +
  "a complete one, it is an authentication bypass: an assertion whose signature is not verified " +
  "is an unauthenticated claim that the bearer is anyone they say they are. Use an OIDC " +
  "connection (Entra, Okta, Auth0, Ping and Keycloak all expose one), or open an issue to add a " +
  "reviewed XML-DSIG dependency.";

/* ------------------------------------------------------------------ */
/* URLs                                                                */
/* ------------------------------------------------------------------ */

export const CALLBACK_PATH = "/api/v1/auth/sso/callback";

/**
 * The exact string an operator must register at the identity provider.
 *
 * Every provider compares this byte for byte, and "redirect_uri_mismatch" is
 * the single most common failure in every SSO integration ever attempted, so
 * it is returned from the API rather than left for somebody to reconstruct.
 */
export function redirectUriFor(config: Config): string {
  return `${config.APP_BASE_URL.replace(/\/+$/, "")}${CALLBACK_PATH}`;
}

/**
 * Accept a post-sign-in destination only if it is a path on our own web app.
 *
 * An open redirect on a login endpoint is a phishing primitive: the victim
 * clicks a link on the real product domain, really signs in, and is handed to
 * the attacker's page still believing they are inside the product. So this
 * takes paths and never origins — no scheme, no host, no protocol-relative
 * `//evil.test`, no backslash trickery.
 */
export function safeReturnTo(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (raw.length > 512) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (/[\r\n\t ]/.test(raw)) return null;
  // Anything that parses as absolute against a throwaway origin but changes
  // the origin is not a path.
  try {
    const probe = new URL(raw, "https://placeholder.invalid");
    if (probe.origin !== "https://placeholder.invalid") return null;
    return `${probe.pathname}${probe.search}${probe.hash}`;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Device labelling                                                    */
/* ------------------------------------------------------------------ */

/** Coarse, human-facing, and deliberately not a tracking identifier. */
export function deviceLabelFor(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : /Firefox\//.test(ua)
            ? "Firefox"
            : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iOS/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "an unknown platform";
  return `${browser} on ${os}`;
}

/** The coarse signature behind `auth_sessions.device_fingerprint`. */
export function deviceSignature(userAgent: string | null, ip: string | null): string {
  const label = deviceLabelFor(userAgent);
  const network = ip ? ip.split(".").slice(0, 3).join(".") : "unknown";
  return `${label}|${network}`;
}
