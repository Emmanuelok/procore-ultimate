/**
 * The on-site register (spec Vol II Z #1067–1069).
 *
 * A turnstile emits a stream of in/out reads. Who is on site NOW is a fold
 * over that stream per person, and the fold has to survive the ways real
 * readers fail: two INs with no OUT between them (tailgating, or a reader
 * that dropped a read), an OUT with no matching IN, a person who never
 * badged out at the end of a shift.
 *
 * The rules, stated rather than implied:
 *   • Events are folded in occurrence order, per person.
 *   • IN while already inside keeps the ORIGINAL entry time and records an
 *     anomaly — the later read is not evidence of a later arrival.
 *   • OUT while not inside records an anomaly and leaves the person outside.
 *   • REFUSED reads (accepted = 0) never change the register; they are
 *     counted so the refusal pattern is visible.
 *   • A person still inside after `overstayHours` is flagged, not removed:
 *     the platform does not invent an exit nobody recorded.
 *
 * This engine is pure. Loading the events and writing the signals is the
 * service's job.
 */

export interface GateEventInput {
  id: string;
  occurredAt: string;
  direction: string;
  accepted: number;
  personKey: string;
  personName: string | null;
  passId: string | null;
  workerId: string | null;
  vendorId: string | null;
  personKind: string | null;
  gateName: string | null;
  source: string | null;
  refusalReason: string | null;
}

export interface RegisterPerson {
  personKey: string;
  personName: string;
  passId: string | null;
  workerId: string | null;
  vendorId: string | null;
  personKind: string | null;
  /** entry time of the CURRENT open session, when inside */
  sinceAt: string | null;
  inside: boolean;
  lastEventAt: string;
  lastDirection: string;
  lastGate: string | null;
  entries: number;
  exits: number;
  refusals: number;
  /** total minutes across completed sessions on the window */
  completedMinutes: number;
  /** minutes of the open session as at `asOf` */
  openMinutes: number | null;
  anomalies: string[];
}

export interface OccupancySummary {
  asOf: string;
  onSite: RegisterPerson[];
  offSite: RegisterPerson[];
  headcount: number;
  byVendor: Record<string, number>;
  byPersonKind: Record<string, number>;
  eventsConsidered: number;
  refusedEvents: number;
  anomalyCount: number;
  overstays: RegisterPerson[];
}

const minutes = (fromIso: string, toIso: string): number =>
  Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / 60_000);

/**
 * Fold the ordered event stream into the register.
 *
 * `asOf` bounds the open sessions: events after it are ignored, so the same
 * function answers "who is on site now" and "who was on site when the fire
 * alarm sounded".
 */
export function buildRegister(
  events: readonly GateEventInput[],
  options: { asOf: string; overstayHours?: number },
): OccupancySummary {
  const asOfMs = Date.parse(options.asOf);
  const overstayHours = options.overstayHours ?? 16;

  const ordered = [...events]
    .filter((e) => Date.parse(e.occurredAt) <= asOfMs)
    .sort((a, b) => {
      const d = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    });

  const people = new Map<string, RegisterPerson>();
  let refusedEvents = 0;

  for (const event of ordered) {
    const key = event.personKey;
    let person = people.get(key);
    if (!person) {
      person = {
        personKey: key,
        personName: event.personName ?? key,
        passId: event.passId,
        workerId: event.workerId,
        vendorId: event.vendorId,
        personKind: event.personKind,
        sinceAt: null,
        inside: false,
        lastEventAt: event.occurredAt,
        lastDirection: event.direction,
        lastGate: event.gateName,
        entries: 0,
        exits: 0,
        refusals: 0,
        completedMinutes: 0,
        openMinutes: null,
        anomalies: [],
      };
      people.set(key, person);
    }
    // Later reads carry the freshest identity the reader knew.
    if (event.personName) person.personName = event.personName;
    if (event.passId) person.passId = event.passId;
    if (event.workerId) person.workerId = event.workerId;
    if (event.vendorId) person.vendorId = event.vendorId;
    if (event.personKind) person.personKind = event.personKind;
    person.lastEventAt = event.occurredAt;
    person.lastDirection = event.direction;
    person.lastGate = event.gateName;

    if (event.accepted === 0) {
      person.refusals += 1;
      refusedEvents += 1;
      continue;
    }

    if (event.direction === "in") {
      person.entries += 1;
      if (person.inside) {
        person.anomalies.push(
          `Entry at ${event.occurredAt} with no exit since ${person.sinceAt ?? "an earlier entry"} — the earlier entry time is kept.`,
        );
      } else {
        person.inside = true;
        person.sinceAt = event.occurredAt;
      }
    } else if (event.direction === "out") {
      person.exits += 1;
      if (!person.inside) {
        person.anomalies.push(`Exit at ${event.occurredAt} with no matching entry.`);
      } else {
        person.completedMinutes += minutes(person.sinceAt ?? event.occurredAt, event.occurredAt);
        person.inside = false;
        person.sinceAt = null;
      }
    }
  }

  const onSite: RegisterPerson[] = [];
  const offSite: RegisterPerson[] = [];
  const overstays: RegisterPerson[] = [];
  const byVendor: Record<string, number> = {};
  const byPersonKind: Record<string, number> = {};
  let anomalyCount = 0;

  for (const person of people.values()) {
    anomalyCount += person.anomalies.length;
    if (person.inside && person.sinceAt) {
      person.openMinutes = Math.round(minutes(person.sinceAt, options.asOf));
      onSite.push(person);
      const vendorKey = person.vendorId ?? "unassigned";
      byVendor[vendorKey] = (byVendor[vendorKey] ?? 0) + 1;
      const kindKey = person.personKind ?? "unknown";
      byPersonKind[kindKey] = (byPersonKind[kindKey] ?? 0) + 1;
      if (person.openMinutes >= overstayHours * 60) overstays.push(person);
    } else {
      person.completedMinutes = Math.round(person.completedMinutes);
      offSite.push(person);
    }
  }

  const byName = (a: RegisterPerson, b: RegisterPerson) => a.personName.localeCompare(b.personName);
  onSite.sort(byName);
  offSite.sort(byName);
  overstays.sort((a, b) => (b.openMinutes ?? 0) - (a.openMinutes ?? 0));

  return {
    asOf: options.asOf,
    onSite,
    offSite,
    headcount: onSite.length,
    byVendor,
    byPersonKind,
    eventsConsidered: ordered.length,
    refusedEvents,
    anomalyCount,
    overstays,
  };
}

/**
 * Hours on site per person per calendar day, derived from the same fold —
 * the independent stream `workforce.site_access_records` is reconciled
 * against. Sessions that span midnight are split at midnight UTC; a session
 * still open at the end of the window contributes nothing, because its
 * duration is not yet a fact.
 */
export interface DailyPresence {
  date: string;
  personKey: string;
  personName: string;
  workerId: string | null;
  firstIn: string | null;
  lastOut: string | null;
  hours: number;
  openAtWindowEnd: boolean;
}

export function dailyPresence(
  events: readonly GateEventInput[],
  options: { from: string; to: string },
): DailyPresence[] {
  const fromMs = Date.parse(`${options.from}T00:00:00.000Z`);
  const toMs = Date.parse(`${options.to}T23:59:59.999Z`);
  const ordered = [...events]
    .filter((e) => e.accepted !== 0)
    .filter((e) => {
      const at = Date.parse(e.occurredAt);
      return at >= fromMs && at <= toMs;
    })
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id));

  const open = new Map<string, GateEventInput>();
  const byKey = new Map<string, DailyPresence>();

  const bucket = (date: string, e: GateEventInput): DailyPresence => {
    const k = `${date}|${e.personKey}`;
    let row = byKey.get(k);
    if (!row) {
      row = {
        date,
        personKey: e.personKey,
        personName: e.personName ?? e.personKey,
        workerId: e.workerId,
        firstIn: null,
        lastOut: null,
        hours: 0,
        openAtWindowEnd: false,
      };
      byKey.set(k, row);
    }
    return row;
  };

  for (const event of ordered) {
    const date = event.occurredAt.slice(0, 10);
    if (event.direction === "in") {
      if (!open.has(event.personKey)) {
        open.set(event.personKey, event);
        const row = bucket(date, event);
        if (!row.firstIn || event.occurredAt < row.firstIn) row.firstIn = event.occurredAt;
      }
    } else if (event.direction === "out") {
      const entry = open.get(event.personKey);
      if (!entry) continue;
      open.delete(event.personKey);
      // Split the session at midnight UTC so a night shift lands on both days.
      let cursor = entry.occurredAt;
      while (cursor.slice(0, 10) < date) {
        const dayStartMs = Date.parse(`${cursor.slice(0, 10)}T00:00:00.000Z`);
        const nextMidnight = new Date(dayStartMs + 86_400_000).toISOString();
        const row = bucket(cursor.slice(0, 10), entry);
        if (!row.firstIn || cursor < row.firstIn) row.firstIn = cursor;
        row.hours += (dayStartMs + 86_400_000 - Date.parse(cursor)) / 3_600_000;
        row.lastOut = nextMidnight;
        cursor = nextMidnight;
      }
      const row = bucket(date, entry);
      if (!row.firstIn || cursor < row.firstIn) row.firstIn = cursor;
      row.hours += (Date.parse(event.occurredAt) - Date.parse(cursor)) / 3_600_000;
      row.lastOut = event.occurredAt;
    }
  }

  for (const entry of open.values()) {
    const row = bucket(entry.occurredAt.slice(0, 10), entry);
    row.openAtWindowEnd = true;
  }

  return [...byKey.values()]
    .map((r) => ({ ...r, hours: Math.round(r.hours * 100) / 100 }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.personName.localeCompare(b.personName));
}
