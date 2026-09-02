import bcrypt from "bcryptjs";
import type { Config } from "../../config.js";

/**
 * Password policy and hashing.
 *
 * Three rules, and each one exists because of a real failure mode:
 *
 *  - LENGTH. The platform shipped with `z.string().min(8)`, which admits
 *    "abcd1234". Eight characters is a 1990s number; twelve is the current
 *    floor everywhere that has looked at a cracking rig this decade. Length is
 *    the only knob that actually buys entropy, so it is the one with teeth.
 *
 *  - A COMMON-PASSWORD LIST. Length alone admits "passwordpassword" and
 *    "123456789012". The list below is deliberately small and embedded: a
 *    30MB breach corpus is a different feature (and a dependency), whereas the
 *    handful of strings that appear in every credential-stuffing run cost
 *    nothing to refuse. The match is EXACT on the lower-cased password, not a
 *    substring: "password" is refused, "correcthorse-password-battery" is not,
 *    because a substring rule rejects strong passwords for containing a weak
 *    word and trains users to pick worse ones.
 *
 *  - THE EMAIL LOCAL-PART. "jane.doe@acme.com" with password "jane.doe2024!"
 *    is the single most guessable shape a real user produces, and it survives
 *    both rules above.
 *
 * WHAT THIS IS NOT: a strength meter. It returns `{ ok, reasons }` — the same
 * shape the benchmark metrics use for a figure it refuses to invent — so the
 * caller can show every reason at once instead of making the user discover
 * them one round-trip at a time.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * The work factor for NEW hashes outside tests. The stored config default is
 * 10 (the value the platform shipped with); this is the floor a hash written
 * today must meet, and `needsRehash` upgrades anything below it on the next
 * successful sign-in.
 *
 * Under NODE_ENV=test the cost is CAPPED instead: bcryptjs is pure JavaScript,
 * cost 12 measures ~320ms per hash against ~95ms at cost 10, and the suite
 * hashes passwords hundreds of times. A test run that takes five minutes
 * longer teaches nobody anything — the upgrade path itself is tested directly
 * (an old cost-6 hash is rehashed to the current target on login).
 */
export const PASSWORD_HASH_COST_FLOOR = 12;
export const PASSWORD_HASH_COST_TEST_CAP = 10;

/**
 * The short list. Every entry is a top-of-the-table string from published
 * breach corpora, or an obvious construction-industry variant of one.
 * Lower-case only — the comparison lower-cases the candidate.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "1234567890",
  "123456789012",
  "12345678901234",
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "passw0rd",
  "passw0rd123",
  "qwerty",
  "qwerty123",
  "qwertyuiop",
  "1q2w3e4r5t",
  "111111",
  "1111111111",
  "000000",
  "0000000000",
  "iloveyou",
  "admin",
  "admin123",
  "administrator",
  "letmein",
  "letmein123",
  "welcome",
  "welcome1",
  "welcome123",
  "monkey",
  "dragon",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "superman",
  "trustno1",
  "abc123",
  "abcd1234",
  "abcdefghijkl",
  "aaaaaaaaaaaa",
  "changeme",
  "changeme123",
  "secret",
  "secret123",
  "whatever",
  "starwars",
  "master",
  "michael",
  "shadow",
  "jesus",
  "ninja",
  "mustang",
  "harley",
  "computer",
  "internet",
  "samsung",
  "google",
  "facebook",
  "constructos",
  "constructos1",
  "constructos123",
  "construction",
  "construction1",
  "construction123",
  "contractor",
  "contractor123",
  "buildit",
  "buildit123",
  "sitesafety",
  "projectmanager",
  "procore123",
]);

export interface PasswordAssessment {
  ok: boolean;
  /** every reason at once, never just the first */
  reasons: string[];
}

export interface PasswordContext {
  /** the account's address — its local part must not appear in the password */
  email?: string | null;
  /** the person's name; a bare "firstname lastname" password is refused */
  name?: string | null;
}

/** The local part of an address, lower-cased. `""` when there isn't one. */
export function emailLocalPart(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.indexOf("@");
  return (at === -1 ? email : email.slice(0, at)).toLowerCase();
}

/**
 * Check a candidate password against the policy.
 *
 * Never throws, never logs the candidate. The caller decides whether a
 * failure is a 400 (a user choosing) or a silent refusal (a token flow).
 */
export function assessPassword(
  password: string,
  context: PasswordContext = {},
): PasswordAssessment {
  const reasons: string[] = [];
  const lower = password.toLowerCase();

  if (password.length < PASSWORD_MIN_LENGTH) {
    reasons.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    reasons.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (password.trim().length === 0) {
    reasons.push("Password must not be blank.");
  }
  if (COMMON_PASSWORDS.has(lower.trim())) {
    reasons.push("Password is one of the most commonly used passwords and is guessed first.");
  }

  const local = emailLocalPart(context.email);
  // Three characters is not distinctive enough to be worth refusing over
  // ("ann@…" would ban every password containing "ann"), four is.
  if (local.length >= 4 && lower.includes(local)) {
    reasons.push("Password must not contain the email address it belongs to.");
  }

  const name = (context.name ?? "").trim().toLowerCase();
  if (name.length >= 5 && lower === name.replace(/\s+/g, "")) {
    reasons.push("Password must not be the account holder's own name.");
  }

  return { ok: reasons.length === 0, reasons };
}

/** The bcrypt cost NEW hashes are written at. See PASSWORD_HASH_COST_FLOOR. */
export function passwordHashCost(config: Pick<Config, "BCRYPT_COST" | "NODE_ENV">): number {
  if (config.NODE_ENV === "test") {
    return Math.min(config.BCRYPT_COST, PASSWORD_HASH_COST_TEST_CAP);
  }
  return Math.max(config.BCRYPT_COST, PASSWORD_HASH_COST_FLOOR);
}

export function hashPassword(
  config: Pick<Config, "BCRYPT_COST" | "NODE_ENV">,
  password: string,
): Promise<string> {
  return bcrypt.hash(password, passwordHashCost(config));
}

/**
 * Compare a candidate against a stored hash.
 *
 * Returns false rather than throwing on a hash bcrypt cannot parse: an
 * SSO-provisioned account stores the sentinel `sso-only:<id>` in
 * `password_hash` precisely so that no password can ever match it, and a
 * thrown error there would turn a correct refusal into a 500.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/**
 * A hash written at a lower work factor than we use today.
 *
 * The cost is encoded in the hash itself, so raising the platform's factor
 * does not invalidate anything — it just means the next successful sign-in
 * should quietly re-hash. Unparseable hashes (the SSO sentinel) are never
 * "upgradeable": there is no password behind them.
 */
export function needsRehash(hash: string, targetCost: number): boolean {
  try {
    return bcrypt.getRounds(hash) < targetCost;
  } catch {
    return false;
  }
}

/**
 * A bcrypt hash of a value nobody knows, used to spend the same time on a
 * sign-in attempt for an address that does not exist as one that does.
 * Without it, "unknown account" answers in a millisecond and "wrong password"
 * answers in a hundred, and the difference is a user-enumeration oracle that
 * no amount of identical response bodies can hide.
 *
 * THE COST MUST MATCH THE COST REAL HASHES CARRY. An earlier version pinned
 * this at 10 while `passwordHashCost` floors production at 12; bcrypt doubles
 * per round, so an unknown address answered in ~95ms and a real one in
 * ~350ms — perfectly separable on a single request, and invisible to the test
 * suite because tests cap at 10, where the two happen to agree. The cache is
 * therefore keyed on the cost, and callers pass the config.
 */
const dummyHashByCost = new Map<number, Promise<string>>();

export async function equalizeVerifyTiming(
  password: string,
  config?: Pick<Config, "BCRYPT_COST" | "NODE_ENV">,
): Promise<false> {
  const cost = config ? passwordHashCost(config) : PASSWORD_HASH_COST_FLOOR;
  let pending = dummyHashByCost.get(cost);
  if (!pending) {
    pending = bcrypt.hash(`no-such-account-${Math.random()}`, cost);
    dummyHashByCost.set(cost, pending);
  }
  await bcrypt.compare(password, await pending);
  return false;
}
