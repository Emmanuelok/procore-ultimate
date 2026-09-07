/**
 * Muster reconciliation (spec Vol II Z #1069).
 *
 * The alarm sounds. The turnstile register says these N people are inside.
 * A marshal at the muster point ticks off the ones standing in front of them.
 * The output of this engine is not a number: it is three named lists.
 *
 *   unaccounted   on the register, not at the muster point — the list that
 *                 sends someone back into the building
 *   present       on the register and checked in
 *   unexpected    checked in but NOT on the register — a tailgater, a visitor
 *                 nobody badged, or a reader that missed a read; equally a
 *                 finding, because the register is wrong
 *
 * A person explicitly marked `accounted_offsite` (the marshal reached them by
 * phone) counts as accounted but not present. Nothing here invents a status:
 * a person on the register with no check-in row is unaccounted, full stop.
 */

export interface RegisterEntry {
  key: string;
  name: string;
  passId: string | null;
  workerId: string | null;
  sinceAt: string | null;
}

export interface CheckinEntry {
  personKey: string;
  personName: string;
  status: string;
  checkedInAt: string | null;
}

export interface MusterPerson {
  key: string;
  name: string;
  passId: string | null;
  workerId: string | null;
  sinceAt: string | null;
  status: "present" | "accounted_offsite" | "unaccounted";
  checkedInAt: string | null;
  onRegister: boolean;
}

export interface MusterReconciliation {
  expectedCount: number;
  accountedCount: number;
  unaccountedCount: number;
  unexpectedCount: number;
  present: MusterPerson[];
  accountedOffsite: MusterPerson[];
  unaccounted: MusterPerson[];
  unexpected: MusterPerson[];
  /** seconds from the declaration to the last check-in, null if none */
  durationSeconds: number | null;
  clear: boolean;
  reasons: string[];
}

const ACCOUNTED = new Set(["present", "accounted_offsite"]);

export function reconcileMuster(
  register: readonly RegisterEntry[],
  checkins: readonly CheckinEntry[],
  options: { declaredAt: string },
): MusterReconciliation {
  const byKey = new Map<string, CheckinEntry>();
  for (const c of checkins) {
    const existing = byKey.get(c.personKey);
    // The strongest claim wins: present beats accounted_offsite beats absent.
    if (!existing || rank(c.status) > rank(existing.status)) byKey.set(c.personKey, c);
  }

  const present: MusterPerson[] = [];
  const accountedOffsite: MusterPerson[] = [];
  const unaccounted: MusterPerson[] = [];
  const unexpected: MusterPerson[] = [];
  const seen = new Set<string>();

  for (const entry of register) {
    seen.add(entry.key);
    const checkin = byKey.get(entry.key);
    const status = checkin && ACCOUNTED.has(checkin.status) ? (checkin.status as "present" | "accounted_offsite") : "unaccounted";
    const person: MusterPerson = {
      key: entry.key,
      name: entry.name,
      passId: entry.passId,
      workerId: entry.workerId,
      sinceAt: entry.sinceAt,
      status,
      checkedInAt: checkin?.checkedInAt ?? null,
      onRegister: true,
    };
    if (status === "present") present.push(person);
    else if (status === "accounted_offsite") accountedOffsite.push(person);
    else unaccounted.push(person);
  }

  for (const [key, checkin] of byKey) {
    if (seen.has(key)) continue;
    if (!ACCOUNTED.has(checkin.status)) continue;
    unexpected.push({
      key,
      name: checkin.personName,
      passId: null,
      workerId: null,
      sinceAt: null,
      status: checkin.status as "present" | "accounted_offsite",
      checkedInAt: checkin.checkedInAt,
      onRegister: false,
    });
  }

  const times = checkins
    .map((c) => c.checkedInAt)
    .filter((t): t is string => Boolean(t))
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t));
  const declaredMs = Date.parse(options.declaredAt);
  const durationSeconds =
    times.length > 0 && Number.isFinite(declaredMs)
      ? Math.max(0, Math.round((Math.max(...times) - declaredMs) / 1000))
      : null;

  const reasons: string[] = [];
  if (register.length === 0) {
    reasons.push(
      "The on-site register was empty at the moment of declaration — either nobody had badged in, or the gate feed is not connected. A clear muster against an empty register proves nothing.",
    );
  }
  if (unexpected.length > 0) {
    reasons.push(
      `${unexpected.length} person(s) reached the muster point without being on the register. Either the gate feed missed their entry or they entered without badging.`,
    );
  }
  if (unaccounted.length > 0) {
    reasons.push(`${unaccounted.length} person(s) on the register have not been accounted for.`);
  }

  const byName = (a: MusterPerson, b: MusterPerson) => a.name.localeCompare(b.name);
  present.sort(byName);
  accountedOffsite.sort(byName);
  unaccounted.sort(byName);
  unexpected.sort(byName);

  return {
    expectedCount: register.length,
    accountedCount: present.length + accountedOffsite.length,
    unaccountedCount: unaccounted.length,
    unexpectedCount: unexpected.length,
    present,
    accountedOffsite,
    unaccounted,
    unexpected,
    durationSeconds,
    clear: register.length > 0 && unaccounted.length === 0,
    reasons,
  };
}

function rank(status: string): number {
  if (status === "present") return 3;
  if (status === "accounted_offsite") return 2;
  return 1;
}
