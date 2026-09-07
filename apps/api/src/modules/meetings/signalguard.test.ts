/**
 * Regression tests for signal idempotency.
 *
 * The in-memory `alreadySignalled(...)` prefilter each sweep uses is enough
 * for SEQUENTIAL runs — it re-reads the register before every pass. What it
 * never covered is two runners overlapping: an operator pressing "sweep now"
 * while the scheduler tick is mid-flight both read "not raised yet" and both
 * insert, because `signals` carries no unique constraint. These tests drive
 * `raiseSignalOnce` directly, which is the only way to exercise the window
 * the prefilter hides.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { signals } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { raiseSignalOnce } from "./signalguard.js";

let built: BuiltApp;
let actor: TestActor;

const DETECTOR = "meeting_action_overdue";

const values = (key: string, over: Record<string, unknown> = {}) => ({
  companyId: actor.companyId,
  projectId: null,
  detector: DETECTOR,
  severity: "high",
  confidence: 1,
  title: `Finding ${key}`,
  explanation: "Raised by a test",
  fingerprint: `${DETECTOR}:${key}`,
  evidenceRefs: { key },
  ...over,
});

async function rowsFor(key: string) {
  return built.app.db
    .select()
    .from(signals)
    .where(
      and(
        eq(signals.companyId, actor.companyId),
        eq(signals.detector, DETECTOR),
        eq(signals.fingerprint, `${DETECTOR}:${key}`),
      ),
    );
}

beforeAll(async () => {
  built = await buildTestApp();
  actor = await registerActor(built.app);
}, 180_000);

afterAll(async () => {
  await built.close();
});

describe("raiseSignalOnce", () => {
  it("inserts a finding once and reports the second attempt as a repeat", async () => {
    const first = await raiseSignalOnce(built.app.db, values("alpha"));
    expect(first.raised).toBe(true);

    const second = await raiseSignalOnce(built.app.db, values("alpha"));
    expect(second.raised).toBe(false);
    expect(second.signalId).toBe(first.signalId);

    const rows = await rowsFor("alpha");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBe(2);
    expect(rows[0]!.lastSeenAt).toBeTruthy();
  });

  it("does not double-raise when two runners overlap on the same finding", async () => {
    const results = await Promise.all([
      raiseSignalOnce(built.app.db, values("beta")),
      raiseSignalOnce(built.app.db, values("beta")),
      raiseSignalOnce(built.app.db, values("beta")),
    ]);
    expect(results.filter((r) => r.raised)).toHaveLength(1);
    expect(new Set(results.map((r) => r.signalId)).size).toBe(1);
    expect(await rowsFor("beta")).toHaveLength(1);
  });

  it("keeps distinct findings distinct, and one company's register out of another's", async () => {
    const a = await raiseSignalOnce(built.app.db, values("gamma"));
    const b = await raiseSignalOnce(built.app.db, values("delta"));
    expect(a.raised).toBe(true);
    expect(b.raised).toBe(true);
    expect(a.signalId).not.toBe(b.signalId);

    const other = await registerActor(built.app);
    const elsewhere = await raiseSignalOnce(
      built.app.db,
      { ...values("gamma"), companyId: other.companyId },
    );
    expect(elsewhere.raised).toBe(true);
    /* Same fingerprint, different tenant: two rows, one per company. */
    const mine = await rowsFor("gamma");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.companyId).toBe(actor.companyId);
  });
});
