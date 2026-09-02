/**
 * Webhook egress guard — SSRF and private-network protection.
 *
 * WHAT WAS WRONG. A webhook endpoint accepted any absolute http(s) URL, the
 * dispatcher POSTed to it from inside the API host's network, and up to
 * WEBHOOK_RESPONSE_BODY_LIMIT characters of whatever answered were stored on
 * the delivery row and shown back to the company admin who configured it. That
 * is a read primitive against the platform's own network: a tenant admin could
 * register `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
 * or `http://10.0.0.5:5432/` and read the first 2 KB of the response. It was
 * acknowledged in docs/security.md and it cannot ship.
 *
 * WHAT IS TRUE NOW. Every URL is checked twice:
 *
 *  1. AT CONFIGURATION (create / patch / rotate). The scheme, the host name and
 *     — when a resolver is available — every address the host resolves to must
 *     pass. A refusal names the rule, because "invalid URL" tells an operator
 *     nothing they can act on.
 *  2. AT SEND. The host is resolved again immediately before the request and
 *     re-checked, which is the DNS-rebinding guard: a name that answered
 *     `93.184.216.34` at creation and `127.0.0.1` at send time is refused, and
 *     the delivery records the refusal instead of the response.
 *
 * The classifier is a PURE FUNCTION over an address string, so every range is
 * unit-tested without a socket or a DNS server, and the resolver is injected so
 * the send path can be driven deterministically in tests.
 *
 * It deliberately does NOT do: a per-tenant domain allowlist (a policy the
 * product has not yet defined), egress through a proxy with its own network
 * policy (the right long-term answer, and an infrastructure decision rather
 * than an application one), or connection pinning to the validated address
 * (`fetch` gives no hook for it; re-resolution immediately before the request
 * closes the window to the width of one DNS cache entry, and the guard is
 * documented as such rather than overclaimed).
 */

/** Why a target was refused. Stable strings — tests and the UI both read them. */
export type SsrfRefusalCode =
  | "unparseable"
  | "scheme"
  | "https_required"
  | "credentials"
  | "hostname"
  | "loopback"
  | "link_local"
  | "private"
  | "unique_local"
  | "multicast"
  | "reserved"
  | "unspecified"
  | "carrier_grade_nat"
  | "resolution_failed"
  | "no_addresses";

export interface SsrfRefusal {
  ok: false;
  code: SsrfRefusalCode;
  reason: string;
}

export interface SsrfApproval {
  ok: true;
  url: string;
  host: string;
  protocol: "http:" | "https:";
  port: number | null;
  /** every address the host resolved to; empty when DNS was not consulted */
  addresses: string[];
}

export type SsrfVerdict = SsrfApproval | SsrfRefusal;

/** Resolve a hostname to its addresses. Injected so tests need no DNS. */
export type HostResolver = (host: string) => Promise<string[]>;

export interface SsrfPolicy {
  /** Refuse plain http. True in production, false in dev/test. */
  requireHttps: boolean;
  /** null = do not consult DNS (literal addresses are still classified). */
  resolve: HostResolver | null;
  /**
   * Host names exempted from the private-range rules. Exists for one reason:
   * a self-hosted deployment whose receiver genuinely lives on the same
   * private network, declared explicitly by an operator rather than inferred.
   */
  allowHosts?: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Host names that are never a legitimate webhook target               */
/* ------------------------------------------------------------------ */

const BLOCKED_HOST_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  // Cloud instance-metadata services answer on names as well as addresses.
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/** Suffixes that only ever name something inside the deployment's own network. */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

/* ------------------------------------------------------------------ */
/* Address classification (pure)                                       */
/* ------------------------------------------------------------------ */

interface Range {
  code: SsrfRefusalCode;
  label: string;
}

function v4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/**
 * Classify an IPv4 address. Returns null when the address is a normal public
 * address, or the rule that refuses it.
 */
export function classifyIpv4(address: string): Range | null {
  const o = v4Octets(address);
  if (!o) return null;
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return { code: "unspecified", label: "0.0.0.0/8 (this network)" };
  if (a === 10) return { code: "private", label: "10.0.0.0/8 (RFC 1918)" };
  if (a === 127) return { code: "loopback", label: "127.0.0.0/8 (loopback)" };
  if (a === 100 && b >= 64 && b <= 127) {
    return { code: "carrier_grade_nat", label: "100.64.0.0/10 (carrier-grade NAT)" };
  }
  if (a === 169 && b === 254) {
    return { code: "link_local", label: "169.254.0.0/16 (link-local, cloud metadata)" };
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return { code: "private", label: "172.16.0.0/12 (RFC 1918)" };
  }
  if (a === 192 && b === 168) return { code: "private", label: "192.168.0.0/16 (RFC 1918)" };
  if (a === 192 && b === 0) return { code: "reserved", label: "192.0.0.0/24 (IETF protocol assignments)" };
  if (a === 198 && (b === 18 || b === 19)) {
    return { code: "reserved", label: "198.18.0.0/15 (benchmarking)" };
  }
  if (a >= 224 && a <= 239) return { code: "multicast", label: "224.0.0.0/4 (multicast)" };
  if (a >= 240) return { code: "reserved", label: "240.0.0.0/4 (reserved / broadcast)" };
  return null;
}

function expandIpv6(address: string): number[] | null {
  const clean = address.split("%")[0] ?? address;
  if (!/^[0-9a-fA-F:.]+$/.test(clean)) return null;
  const halves = clean.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      if (piece === "") return null;
      if (piece.includes(".")) {
        const o = v4Octets(piece);
        if (!o) return null;
        groups.push((o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0] ?? "");
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseGroups(halves[1] ?? "");
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** Classify an IPv6 address, following IPv4-mapped addresses into the v4 rules. */
export function classifyIpv6(address: string): Range | null {
  const g = expandIpv6(address);
  if (!g) return null;
  const isZeroPrefix = g.slice(0, 5).every((x) => x === 0);
  // ::ffff:a.b.c.d — an IPv4 address wearing a v6 hat. Classify the v4.
  if (isZeroPrefix && g[5] === 0xffff) {
    const v4 = `${(g[6]! >> 8) & 0xff}.${g[6]! & 0xff}.${(g[7]! >> 8) & 0xff}.${g[7]! & 0xff}`;
    return classifyIpv4(v4) ?? null;
  }
  if (g.every((x) => x === 0)) return { code: "unspecified", label: ":: (unspecified)" };
  if (isZeroPrefix && g[5] === 0 && g[6] === 0 && g[7] === 1) {
    return { code: "loopback", label: "::1 (loopback)" };
  }
  const first = g[0]!;
  if ((first & 0xffc0) === 0xfe80) return { code: "link_local", label: "fe80::/10 (link-local)" };
  if ((first & 0xfe00) === 0xfc00) return { code: "unique_local", label: "fc00::/7 (unique local)" };
  if ((first & 0xff00) === 0xff00) return { code: "multicast", label: "ff00::/8 (multicast)" };
  // NAT64 well-known prefix embeds an IPv4 address: classify the embedded one.
  if (first === 0x0064 && g[1] === 0xff9b) {
    const v4 = `${(g[6]! >> 8) & 0xff}.${g[6]! & 0xff}.${(g[7]! >> 8) & 0xff}.${g[7]! & 0xff}`;
    const inner = classifyIpv4(v4);
    if (inner) return inner;
  }
  return null;
}

/** Classify any address string. `null` means "a normal, routable public address". */
export function classifyAddress(address: string): Range | null {
  const trimmed = address.trim().replace(/^\[|\]$/g, "");
  if (trimmed === "") return { code: "unspecified", label: "empty address" };
  if (trimmed.includes(":")) return classifyIpv6(trimmed);
  return classifyIpv4(trimmed);
}

function looksLikeIpLiteral(host: string): boolean {
  return host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/* ------------------------------------------------------------------ */
/* The guard                                                           */
/* ------------------------------------------------------------------ */

const refuse = (code: SsrfRefusalCode, reason: string): SsrfRefusal => ({ ok: false, code, reason });

/**
 * Check a webhook target. Synchronous portion (scheme, host name, literal
 * address) is separated from the DNS portion so a caller with no resolver — a
 * unit test, or a deployment that deliberately does not resolve — still gets
 * the whole literal-address ruleset.
 */
export function checkWebhookUrlSync(
  raw: string,
  policy: Pick<SsrfPolicy, "requireHttps" | "allowHosts">,
): SsrfVerdict {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refuse("unparseable", "url must be an absolute http:// or https:// URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return refuse("scheme", `url scheme "${parsed.protocol}" is not deliverable — use http or https`);
  }
  if (policy.requireHttps && parsed.protocol !== "https:") {
    return refuse(
      "https_required",
      "plain http is refused in this environment — a webhook carries tenant data and must be https",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return refuse(
      "credentials",
      "url must not embed credentials — the signature is the authentication",
    );
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "") return refuse("hostname", "url has no host");
  const allowed = new Set((policy.allowHosts ?? []).map((h) => h.toLowerCase()));
  const port = parsed.port === "" ? null : Number(parsed.port);
  const approval: SsrfApproval = {
    ok: true,
    url: parsed.toString(),
    host,
    protocol: parsed.protocol,
    port,
    addresses: [],
  };
  if (allowed.has(host)) return approval;

  if (BLOCKED_HOST_NAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return refuse(
      "hostname",
      `host "${host}" names something inside the deployment's own network and is not a deliverable target`,
    );
  }
  if (looksLikeIpLiteral(host)) {
    const verdict = classifyAddress(host);
    if (verdict) {
      return refuse(
        verdict.code,
        `host ${host} is in ${verdict.label} — a webhook may not target the platform's own network`,
      );
    }
  }
  return approval;
}

/**
 * The full check: scheme and host name, then every address the host resolves
 * to. A host that resolves to a mix of public and private addresses is refused
 * outright — "one of the answers is fine" is not a security property.
 */
export async function checkWebhookUrl(raw: string, policy: SsrfPolicy): Promise<SsrfVerdict> {
  const sync = checkWebhookUrlSync(raw, policy);
  if (!sync.ok) return sync;
  const allowed = new Set((policy.allowHosts ?? []).map((h) => h.toLowerCase()));
  if (allowed.has(sync.host)) return sync;
  if (!policy.resolve || looksLikeIpLiteral(sync.host)) return sync;

  let addresses: string[];
  try {
    addresses = await policy.resolve(sync.host);
  } catch (err) {
    return refuse(
      "resolution_failed",
      `host "${sync.host}" could not be resolved (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (addresses.length === 0) {
    return refuse("no_addresses", `host "${sync.host}" resolved to no addresses`);
  }
  for (const address of addresses) {
    const verdict = classifyAddress(address);
    if (verdict) {
      return refuse(
        verdict.code,
        `host "${sync.host}" resolves to ${address} in ${verdict.label} — a webhook may not ` +
          "target the platform's own network",
      );
    }
  }
  return { ...sync, addresses };
}

/** The production resolver: both address families, no caching of our own. */
export function nodeResolver(): HostResolver {
  return async (host) => {
    const dns = await import("node:dns/promises");
    const records = await dns.lookup(host, { all: true, verbatim: true });
    return records.map((r) => r.address);
  };
}

/**
 * Policy for a running deployment. Production insists on https and consults
 * DNS; development and test check literals only, so a suite never depends on a
 * name server and a developer can point a hook at a local tunnel.
 */
export function policyFor(env: { NODE_ENV: string; WEBHOOK_ALLOW_HOSTS?: string }): SsrfPolicy {
  const isProduction = env.NODE_ENV === "production";
  const allowHosts = (env.WEBHOOK_ALLOW_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return {
    requireHttps: isProduction,
    resolve: isProduction ? nodeResolver() : null,
    allowHosts,
  };
}
