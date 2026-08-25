import { describe, expect, it } from "vitest";
import { epochMs, isExpired, isFuture } from "./time.js";

/**
 * Regression cover for a bug that was invisible on every day but the one that
 * mattered. Timestamp columns are `mode: "string"`, so Postgres returns
 * "2026-08-25 23:00:00.142+00" while the application produces
 * "2026-08-25T23:00:00.142Z". Compared as strings the date halves agree and
 * the separator decides: a space (0x20) sorts before "T" (0x54), so a
 * credential valid until 23:00 read as expired at 10:00.
 */
describe("timestamp comparison", () => {
  const pgLater = "2026-08-25 23:00:00.142+00";
  const isoEarlier = "2026-08-25T10:00:00.000Z";

  it("string comparison of the two spellings is wrong on the expiry day", () => {
    // The bug, pinned so nobody reintroduces it believing it works.
    expect(pgLater > isoEarlier).toBe(false);
    expect(Date.parse(pgLater) > Date.parse(isoEarlier)).toBe(true);
  });

  it("does not treat a still-valid postgres timestamp as expired", () => {
    expect(isExpired(pgLater, Date.parse(isoEarlier))).toBe(false);
    expect(isFuture(pgLater, Date.parse(isoEarlier))).toBe(true);
  });

  it("expires a postgres timestamp that has genuinely passed", () => {
    expect(isExpired("2026-08-25 09:00:00+00", Date.parse(isoEarlier))).toBe(true);
  });

  it("treats the exact instant as expired and the next millisecond as live", () => {
    const at = Date.parse(isoEarlier);
    expect(isExpired(isoEarlier, at)).toBe(true);
    expect(isExpired(isoEarlier, at - 1)).toBe(false);
  });

  it("never expires a null or absent expiry", () => {
    expect(isExpired(null)).toBe(false);
    expect(isExpired(undefined)).toBe(false);
    expect(isFuture(null)).toBe(false);
  });

  it("treats an unparseable value as no expiry rather than as expired", () => {
    expect(epochMs("not a timestamp")).toBeNull();
    expect(isExpired("not a timestamp")).toBe(false);
  });
});
